import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, makeRpc, asRole, seedLetter, MIGRATION_URL } from './helpers/db.mjs';

const hash = (c) => c.repeat(64);
const uuid = () => crypto.randomUUID();

test('마이그레이션: 아리사 전용 이름만 만들고 모카 객체는 건드리지 않음', async () => {
  const sql = readFileSync(MIGRATION_URL, 'utf8');
  assert.doesNotMatch(sql, /\bmoka_|public\.moka|mark_moka|\bprofiles\b|is_admin|auth\.users|drop table|alter table public\.(?!arisa_)/i);

  const db = await createTestDb();
  const { rows } = await db.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by 1`,
  );
  assert.deepEqual(rows.map((r) => r.relname), [
    'arisa_last_live_letters', 'arisa_letter_submission_limits', 'arisa_letterbox_auth_attempts',
  ]);
  const fns = await db.query(
    `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
  );
  assert.ok(fns.rows.every((r) => r.proname.startsWith('arisa_')));

  // 두 번 실행해도 안전
  await db.exec(sql);
  await db.close();
});

test('권한: anon / authenticated 는 테이블도 함수도 쓸 수 없음 (RLS + revoke)', async () => {
  const db = await createTestDb();
  const id = await seedLetter(db, { content: '비밀 편지' });
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['arisa_last_live_letters', 'arisa_letter_submission_limits', 'arisa_letterbox_auth_attempts']) {
      await assert.rejects(asRole(db, role, `select * from public.${table}`), /permission denied/, `${role} select ${table}`);
      await assert.rejects(asRole(db, role, `delete from public.${table}`), /permission denied/);
    }
    await assert.rejects(
      asRole(db, role, `insert into public.arisa_last_live_letters (content) values ('x')`), /permission denied/);
    await assert.rejects(
      asRole(db, role, `update public.arisa_last_live_letters set moderation_status = 'approved'`), /permission denied/);
    await assert.rejects(asRole(db, role, `select public.arisa_list_letters('all','desc',1,12)`), /permission denied/);
    await assert.rejects(asRole(db, role, `select public.arisa_get_letter($1::uuid,'all','desc')`, [id]), /permission denied/);
    await assert.rejects(asRole(db, role, `select public.arisa_mark_letter_read($1::uuid)`, [id]), /permission denied/);
    await assert.rejects(asRole(db, role, `select public.arisa_admin_set_status($1::uuid,'approved')`, [id]), /permission denied/);
    await assert.rejects(asRole(db, role, `select public.arisa_admin_list_letters('all','',1,20)`), /permission denied/);
  }
  // RLS 확인: 테이블 권한을 억지로 줘도 정책이 없어 0행
  await db.exec('grant select on public.arisa_last_live_letters to anon');
  const seen = await asRole(db, 'anon', 'select * from public.arisa_last_live_letters');
  assert.equal(seen.rows.length, 0);
  await db.close();
});

test('편지 테이블: 항상 pending 으로 시작하고 입력 규칙을 DB 에서도 지킴', async () => {
  const db = await createTestDb();
  const ins = await db.query(
    `insert into public.arisa_last_live_letters (content, moderation_status, created_at, reviewed_at, read_at)
     values ('안녕', 'approved', '2000-01-01', now(), now()) returning *`,
  );
  const row = ins.rows[0];
  assert.equal(row.moderation_status, 'pending');
  assert.ok(row.created_at.getFullYear() >= 2026);
  assert.equal(row.reviewed_at, null);
  assert.equal(row.read_at, null);

  const bad = [
    [`''`, '빈 내용'],
    [`E' \\n\\t '`, '공백뿐'],
    [`E'a\\rb'`, 'CR 포함'],
    [`repeat('a', 262145)`, '256KiB 초과'],
    [`repeat(E'줄\\n', 2000) || '끝'`, '2,001줄'],
  ];
  for (const [expr, label] of bad) {
    await assert.rejects(db.query(`insert into public.arisa_last_live_letters (content) values (${expr})`), /check constraint/, label);
  }
  await db.query(`insert into public.arisa_last_live_letters (content) values (repeat(E'줄\\n', 1999) || '끝')`); // 정확히 2,000줄
  await db.query(`insert into public.arisa_last_live_letters (content) values (repeat('a', 262144))`); // 정확히 256KiB
  await assert.rejects(
    db.query(`insert into public.arisa_last_live_letters (sender_name, content) values (repeat('가', 41), 'x')`), /check constraint/);
  await assert.rejects(
    db.query(`insert into public.arisa_last_live_letters (sender_name, content) values (' 앞뒤공백 ', 'x')`), /check constraint/);
  await db.close();
});

test('제출 RPC: 저장 → 재시도 → 48시간 제한 → 48시간 뒤 다시 가능', async () => {
  const db = await createTestDb();
  const rpc = makeRpc(db);
  const key = uuid();
  const args = (k, content = '첫 편지') => ({ p_browser_hash: hash('a'), p_idempotency_key: k, p_sender_name: '', p_content: content });

  const first = await rpc('arisa_submit_letter', args(key));
  assert.equal(first.status, 'created');
  assert.equal(first.next_allowed_at_ms - first.server_now_ms >= 48 * 3600 * 1000 - 5, true);

  const replay = await rpc('arisa_submit_letter', args(key));
  assert.equal(replay.status, 'replayed');
  assert.equal((await db.query('select count(*)::int as n from public.arisa_last_live_letters')).rows[0].n, 1);

  const limited = await rpc('arisa_submit_letter', args(uuid(), '두 번째'));
  assert.equal(limited.status, 'limited');
  assert.equal(limited.next_allowed_at_ms, first.next_allowed_at_ms);

  // 다른 브라우저는 영향 없음
  const other = await rpc('arisa_submit_letter', { ...args(uuid()), p_browser_hash: hash('b') });
  assert.equal(other.status, 'created');

  const status = await rpc('arisa_get_submit_status', { p_browser_hash: hash('a') });
  assert.equal(status.next_allowed_at_ms, first.next_allowed_at_ms);

  // 제한 시각이 지나기 직전 / 직후
  await db.query(`update public.arisa_letter_submission_limits set next_allowed_at = now() + interval '1 second' where browser_hash = $1`, [hash('a')]);
  assert.equal((await rpc('arisa_submit_letter', args(uuid(), '아직'))).status, 'limited');
  await db.query(`update public.arisa_letter_submission_limits set next_allowed_at = now() - interval '1 second' where browser_hash = $1`, [hash('a')]);
  assert.equal((await rpc('arisa_submit_letter', args(uuid(), '이제 가능'))).status, 'created');

  await assert.rejects(rpc('arisa_submit_letter', { ...args(uuid()), p_browser_hash: 'short' }), /invalid browser hash/);
  const rows = await db.query('select moderation_status, sender_name from public.arisa_last_live_letters');
  assert.ok(rows.rows.every((r) => r.moderation_status === 'pending' && r.sender_name === null));
  await db.close();
});

test('아리사 편지함 RPC: 승인된 편지만, 필터·정렬·페이지·이웃 편지', async () => {
  const db = await createTestDb();
  const rpc = makeRpc(db);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(await seedLetter(db, {
      name: `팬${i}`, content: `본문${i}`, status: 'approved', createdAt: `2026-10-0${i + 1}T00:00:00Z`, read: i === 1 || i === 3,
    }));
  }
  const pending = await seedLetter(db, { content: '대기 편지', status: 'pending', createdAt: '2026-10-06T00:00:00Z' });
  const hidden = await seedLetter(db, { content: '숨김 편지', status: 'hidden', createdAt: '2026-10-07T00:00:00Z' });

  const all = await rpc('arisa_list_letters', { p_filter: 'all', p_sort: 'desc', p_page: 1, p_page_size: 12 });
  assert.deepEqual(all.counts, { total: 5, unread: 3, read: 2 });
  assert.deepEqual(all.items.map((i) => i.sender_name), ['팬4', '팬3', '팬2', '팬1', '팬0']);
  assert.ok(all.items.every((i) => !('content' in i) && !('moderation_status' in i)));
  assert.ok(!JSON.stringify(all).includes('대기 편지') && !JSON.stringify(all).includes('숨김 편지'));

  const asc = await rpc('arisa_list_letters', { p_filter: 'all', p_sort: 'asc', p_page: 1, p_page_size: 2 });
  assert.deepEqual(asc.items.map((i) => i.sender_name), ['팬0', '팬1']);
  assert.equal(asc.total_pages, 3);
  const last = await rpc('arisa_list_letters', { p_filter: 'all', p_sort: 'asc', p_page: 99, p_page_size: 2 });
  assert.equal(last.page, 3);
  assert.deepEqual(last.items.map((i) => i.sender_name), ['팬4']);

  const unread = await rpc('arisa_list_letters', { p_filter: 'unread', p_sort: 'asc', p_page: 1, p_page_size: 12 });
  assert.deepEqual(unread.items.map((i) => i.sender_name), ['팬0', '팬2', '팬4']);
  assert.ok(unread.items.every((i) => i.is_read === false));
  const read = await rpc('arisa_list_letters', { p_filter: 'read', p_sort: 'desc', p_page: 1, p_page_size: 12 });
  assert.deepEqual(read.items.map((i) => i.sender_name), ['팬3', '팬1']);
  // 이상한 입력은 안전한 기본값으로
  const weird = await rpc('arisa_list_letters', { p_filter: "x'; drop table", p_sort: 'sideways', p_page: -5, p_page_size: 9999 });
  assert.equal(weird.items.length, 5);
  assert.equal(weird.page, 1);

  // 상세: 승인된 편지만
  assert.equal(await rpc('arisa_get_letter', { p_id: pending, p_filter: 'all', p_sort: 'desc' }), null);
  assert.equal(await rpc('arisa_get_letter', { p_id: hidden, p_filter: 'all', p_sort: 'desc' }), null);
  assert.equal(await rpc('arisa_get_letter', { p_id: uuid(), p_filter: 'all', p_sort: 'desc' }), null);

  const mid = await rpc('arisa_get_letter', { p_id: ids[2], p_filter: 'all', p_sort: 'desc' });
  assert.equal(mid.content, '본문2');
  assert.equal(mid.prev_id, ids[3]);
  assert.equal(mid.next_id, ids[1]);
  assert.ok(!('moderation_status' in mid));
  const midAsc = await rpc('arisa_get_letter', { p_id: ids[2], p_filter: 'all', p_sort: 'asc' });
  assert.equal(midAsc.prev_id, ids[1]);
  assert.equal(midAsc.next_id, ids[3]);
  const midUnread = await rpc('arisa_get_letter', { p_id: ids[2], p_filter: 'unread', p_sort: 'asc' });
  assert.equal(midUnread.prev_id, ids[0]);
  assert.equal(midUnread.next_id, ids[4]);
  const firstOne = await rpc('arisa_get_letter', { p_id: ids[4], p_filter: 'all', p_sort: 'desc' });
  assert.equal(firstOne.prev_id, null);
  await db.close();
});

test('읽음 기록: 승인된 편지의 최초 1회만, DB 시각 그대로 유지', async () => {
  const db = await createTestDb();
  const rpc = makeRpc(db);
  const id = await seedLetter(db, { status: 'approved' });
  const pending = await seedLetter(db, { status: 'pending' });

  assert.equal(await rpc('arisa_mark_letter_read', { p_id: pending }), null);
  assert.equal(await rpc('arisa_mark_letter_read', { p_id: uuid() }), null);
  assert.equal((await db.query('select read_at from public.arisa_last_live_letters where id = $1', [pending])).rows[0].read_at, null);

  const first = await rpc('arisa_mark_letter_read', { p_id: id });
  assert.ok(first.read_at);
  const again = await rpc('arisa_mark_letter_read', { p_id: id });
  assert.equal(Date.parse(again.read_at), Date.parse(first.read_at));

  // 관리자 목록·미리보기·상태 변경은 read_at 을 건드리지 않음
  const fresh = await seedLetter(db, { status: 'pending' });
  await rpc('arisa_admin_get_letter', { p_id: fresh });
  await rpc('arisa_admin_list_letters', { p_status: 'all', p_search: '', p_page: 1, p_page_size: 20 });
  await rpc('arisa_admin_set_status', { p_id: fresh, p_status: 'approved' });
  await rpc('arisa_admin_set_status', { p_id: fresh, p_status: 'hidden' });
  assert.equal((await db.query('select read_at from public.arisa_last_live_letters where id = $1', [fresh])).rows[0].read_at, null);
  await db.close();
});

test('관리자 RPC: 상태 변경, 승인 취소, 검색, 통계', async () => {
  const db = await createTestDb();
  const rpc = makeRpc(db);
  const a = await seedLetter(db, { name: '하나', content: '100% 사랑해요', status: 'pending' });
  const b = await seedLetter(db, { name: '둘', content: 'under_score', status: 'approved', read: true });
  await seedLetter(db, { name: null, content: '숨김 편지', status: 'hidden' });

  let list = await rpc('arisa_admin_list_letters', { p_status: 'all', p_search: '', p_page: 1, p_page_size: 20 });
  assert.deepEqual(list.counts, { total: 3, pending: 1, approved: 1, hidden: 1, read: 1, unread_approved: 0 });
  assert.equal(list.items.length, 3);

  list = await rpc('arisa_admin_list_letters', { p_status: 'pending', p_search: '', p_page: 1, p_page_size: 20 });
  assert.deepEqual(list.items.map((i) => i.id), [a]);

  // % 와 _ 는 글자 그대로 검색
  list = await rpc('arisa_admin_list_letters', { p_status: 'all', p_search: '100%', p_page: 1, p_page_size: 20 });
  assert.deepEqual(list.items.map((i) => i.id), [a]);
  list = await rpc('arisa_admin_list_letters', { p_status: 'all', p_search: 'n_e', p_page: 1, p_page_size: 20 });
  assert.equal(list.items.length, 0);
  list = await rpc('arisa_admin_list_letters', { p_status: 'all', p_search: 'r_s', p_page: 1, p_page_size: 20 });
  assert.deepEqual(list.items.map((i) => i.id), [b]);
  list = await rpc('arisa_admin_list_letters', { p_status: 'all', p_search: '둘', p_page: 1, p_page_size: 20 });
  assert.deepEqual(list.items.map((i) => i.id), [b]);

  const approved = await rpc('arisa_admin_set_status', { p_id: a, p_status: 'approved' });
  assert.equal(approved.moderation_status, 'approved');
  assert.ok(approved.reviewed_at);
  // 승인 취소 → 대기: reviewed_at 비움, 아리사에게는 다시 보이지 않음
  const back = await rpc('arisa_admin_set_status', { p_id: a, p_status: 'pending' });
  assert.equal(back.moderation_status, 'pending');
  assert.equal(back.reviewed_at, null);
  assert.equal(await rpc('arisa_get_letter', { p_id: a, p_filter: 'all', p_sort: 'desc' }), null);
  await rpc('arisa_admin_set_status', { p_id: a, p_status: 'hidden' });
  assert.equal(await rpc('arisa_get_letter', { p_id: a, p_filter: 'all', p_sort: 'desc' }), null);

  assert.equal(await rpc('arisa_admin_set_status', { p_id: uuid(), p_status: 'approved' }), null);
  await assert.rejects(rpc('arisa_admin_set_status', { p_id: a, p_status: 'deleted' }), /invalid status/);

  const detail = await rpc('arisa_admin_get_letter', { p_id: a });
  assert.equal(detail.content, '100% 사랑해요');
  assert.equal(detail.moderation_status, 'hidden');
  assert.equal(await rpc('arisa_admin_get_letter', { p_id: uuid() }), null);

  // 본문·작성자는 이 RPC 로 바뀌지 않음
  const row = (await db.query('select sender_name, content from public.arisa_last_live_letters where id = $1', [a])).rows[0];
  assert.deepEqual(row, { sender_name: '하나', content: '100% 사랑해요' });
  await db.close();
});

test('로그인 실패 제한: 5번 틀리면 잠기고, 성공하면 초기화', async () => {
  const db = await createTestDb();
  const rpc = makeRpc(db);
  const key = hash('c');
  const a = { p_key: key, p_window_seconds: 900, p_max: 5 };
  assert.equal(await rpc('arisa_auth_lock_seconds', a), 0);
  for (let i = 0; i < 4; i++) assert.equal(await rpc('arisa_auth_register_failure', a), 0);
  const locked = await rpc('arisa_auth_register_failure', a);
  assert.ok(locked > 800 && locked <= 900);
  assert.ok((await rpc('arisa_auth_lock_seconds', a)) > 0);
  assert.equal(await rpc('arisa_auth_lock_seconds', { ...a, p_key: hash('d') }), 0);

  await db.query(`update public.arisa_letterbox_auth_attempts set window_started_at = now() - interval '16 minutes'`);
  assert.equal(await rpc('arisa_auth_lock_seconds', a), 0);
  assert.equal(await rpc('arisa_auth_register_failure', a), 0); // 창이 지나면 1회부터 다시 시작

  await rpc('arisa_auth_clear_failures', { p_key: key });
  assert.equal((await db.query('select count(*)::int as n from public.arisa_letterbox_auth_attempts')).rows[0].n, 0);
  await db.close();
});
