import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, makeRpc, seedLetter } from './helpers/db.mjs';
import { ENV, ADMIN_UID, OTHER_UID, ACCESS_CODE, cookieOf, req, silenceErrors } from './helpers/env.mjs';
import {
  handleAdminSession, handleAdminList, handleAdminLetter, handleAdminSetStatus, ADMIN_COOKIE,
} from '../server/admin-api.js';
import { handleReaderSession, handleReaderList, READER_COOKIE } from '../server/reader-api.js';
import { createPasswordLogin } from '../server/supabase.js';

const ip = (n) => ({ 'CF-Connecting-IP': `198.51.100.${n}` });

test('관리자 API', async (t) => {
  const db = await createTestDb();
  const accounts = {
    'admin@example.com': { password: 'right-password', userId: ADMIN_UID },
    'other@example.com': { password: 'other-password', userId: OTHER_UID }, // 로그인은 되지만 관리자 UID 가 아님
  };
  const passwordLogin = async (email, password) => {
    const a = accounts[email];
    return a && a.password === password ? { ok: true, userId: a.userId } : { ok: false, reason: 'invalid' };
  };
  const deps = { rpc: makeRpc(db), passwordLogin };
  const loginReq = (email, password, n = 1, extra = {}) =>
    handleAdminSession(req('/api/admin/session', { method: 'POST', body: { email, password }, headers: ip(n), ...extra }), ENV, deps);

  const a = await seedLetter(db, { name: '팬A', content: '대기 중인 편지', status: 'pending' });
  const b = await seedLetter(db, { name: '팬B', content: '승인된 편지', status: 'approved' });
  const c = await seedLetter(db, { name: null, content: '숨긴 편지', status: 'hidden' });
  const readState = async (id) => (await db.query('select read_at from public.arisa_last_live_letters where id = $1', [id])).rows[0].read_at;

  let cookie;

  await t.test('로그인 전에는 목록·미리보기·상태 변경 모두 401', async () => {
    assert.equal((await handleAdminList(req('/api/admin/letters'), ENV, deps)).status, 401);
    assert.equal((await handleAdminLetter(req(`/api/admin/letters/${a}`), ENV, a, deps)).status, 401);
    const patch = await handleAdminSetStatus(req(`/api/admin/letters/${a}`, { method: 'PATCH', body: { status: 'approved' } }), ENV, a, deps);
    assert.equal(patch.status, 401);
    assert.equal((await db.query('select moderation_status from public.arisa_last_live_letters where id = $1', [a])).rows[0].moderation_status, 'pending');
  });

  await t.test('틀린 비밀번호 / 관리자가 아닌 계정 / 없는 계정은 똑같은 401 응답', async () => {
    const wrong = await loginReq('admin@example.com', 'bad', 1);
    const notAdmin = await loginReq('other@example.com', 'other-password', 2);
    const unknown = await loginReq('nobody@example.com', 'x', 3);
    for (const res of [wrong, notAdmin, unknown]) {
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('Set-Cookie'), null);
    }
    const bodies = await Promise.all([wrong, notAdmin, unknown].map((r) => r.text()));
    assert.equal(new Set(bodies).size, 1);
    assert.equal(JSON.parse(bodies[0]).code, 'invalid_credentials');
  });

  await t.test('입력 검사: 형식이 틀린 값은 로그인 서버를 부르지 않고 401', async () => {
    let called = 0;
    const counting = { ...deps, passwordLogin: async () => { called++; return { ok: false, reason: 'invalid' }; } };
    for (const body of [{}, { email: 'a@b.c' }, { email: 'no-at', password: 'x' }, { email: 'a@b.c', password: 'x'.repeat(201) }, { email: 5, password: 6 }]) {
      const res = await handleAdminSession(req('/api/admin/session', { method: 'POST', body, headers: ip(4) }), ENV, counting);
      assert.equal(res.status, 401, JSON.stringify(body));
    }
    assert.equal(called, 0);
    assert.equal((await handleAdminSession(req('/api/admin/session', { method: 'POST', body: '[1]', headers: ip(4) }), ENV, deps)).status, 400);
  });

  await t.test('로그인 요청은 같은 사이트에서만', async () => {
    assert.equal((await loginReq('admin@example.com', 'right-password', 5, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await loginReq('admin@example.com', 'right-password', 5, { origin: null })).status, 403);
  });

  await t.test('관리자 로그인 성공: 별도 쿠키 (HttpOnly · Strict · /api/admin), 토큰은 응답에 없음', async () => {
    const res = await loginReq('Admin@Example.com ', 'right-password', 6);
    assert.equal(res.status, 200);
    const set = res.headers.get('Set-Cookie');
    assert.match(set, new RegExp(`^${ADMIN_COOKIE}=v1\\.`));
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /Path=\/api\/admin/);
    assert.match(set, /Secure/);
    assert.match(set, /Max-Age=28800/);
    assert.deepEqual(await res.json(), { ok: true, authenticated: true });
    cookie = cookieOf(res, ADMIN_COOKIE);
    const s = await (await handleAdminSession(req('/api/admin/session', { cookie }), ENV, deps)).json();
    assert.equal(s.authenticated, true);
  });

  await t.test('목록: 모든 상태와 통계, 검색, 상태 필터', async () => {
    const res = await handleAdminList(req('/api/admin/letters', { cookie }), ENV, deps);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    const body = await res.json();
    assert.deepEqual(body.counts, { total: 3, pending: 1, approved: 1, hidden: 1, read: 0, unread_approved: 1 });
    assert.equal(body.items.length, 3);
    assert.deepEqual(Object.keys(body.items[0]).sort(),
      ['created_at', 'id', 'is_read', 'moderation_status', 'preview', 'reviewed_at', 'sender_name']);

    const pending = await (await handleAdminList(req('/api/admin/letters?status=pending', { cookie }), ENV, deps)).json();
    assert.deepEqual(pending.items.map((i) => i.id), [a]);
    const found = await (await handleAdminList(req(`/api/admin/letters?q=${encodeURIComponent('승인된')}`, { cookie }), ENV, deps)).json();
    assert.deepEqual(found.items.map((i) => i.id), [b]);
    const weird = await (await handleAdminList(req(`/api/admin/letters?status=evil&page=abc`, { cookie }), ENV, deps)).json();
    assert.equal(weird.items.length, 3);
  });

  await t.test('미리보기: 대기·숨김 편지도 볼 수 있지만 읽음은 기록하지 않음', async () => {
    for (const id of [a, b, c]) {
      const res = await handleAdminLetter(req(`/api/admin/letters/${id}`, { cookie }), ENV, id, deps);
      assert.equal(res.status, 200);
      assert.ok((await res.json()).content);
      assert.equal(await readState(id), null);
    }
    assert.equal((await handleAdminLetter(req('/api/admin/letters/x', { cookie }), ENV, 'x', deps)).status, 404);
    const unknown = crypto.randomUUID();
    assert.equal((await handleAdminLetter(req(`/api/admin/letters/${unknown}`, { cookie }), ENV, unknown, deps)).status, 404);
  });

  await t.test('승인 → 아리사 편지함에 나타남, 승인 취소·숨김 → 사라짐', async () => {
    const patch = (id, body, extra = {}) =>
      handleAdminSetStatus(req(`/api/admin/letters/${id}`, { method: 'PATCH', body, cookie, ...extra }), ENV, id, deps);

    assert.equal((await patch(a, { status: 'approved' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await patch(a, { status: 'deleted' })).status, 400);
    assert.equal((await patch(a, { status: 'approved', content: '바꿔치기' })).status, 400);
    assert.equal((await patch(a, { content: '바꿔치기' })).status, 400);
    assert.equal((await patch(crypto.randomUUID(), { status: 'approved' })).status, 404);

    const readerList = async () => {
      const r = await handleReaderSession(req('/api/arisa/session', { method: 'POST', body: { code: ACCESS_CODE }, headers: ip(50) }), ENV, deps);
      const rc = cookieOf(r, READER_COOKIE);
      return (await (await handleReaderList(req('/api/arisa/letters', { cookie: rc }), ENV, deps)).json()).items.map((i) => i.id);
    };

    assert.deepEqual(await readerList(), [b]);
    const ok = await patch(a, { status: 'approved' });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.moderation_status, 'approved');
    assert.ok(okBody.reviewed_at);
    assert.deepEqual((await readerList()).sort(), [a, b].sort());

    assert.equal((await (await patch(a, { status: 'pending' })).json()).reviewed_at, null);
    assert.deepEqual(await readerList(), [b]);
    await patch(b, { status: 'hidden' });
    assert.deepEqual(await readerList(), []);
    assert.equal(await readState(a), null);
    assert.equal(await readState(b), null);
  });

  await t.test('허용 목록에서 UID 를 빼면 이미 발급된 세션도 바로 무효', async () => {
    assert.equal((await handleAdminList(req('/api/admin/letters', { cookie }), ENV, deps)).status, 200);
    const revoked = { ...ENV, ARISA_ADMIN_UIDS: OTHER_UID };
    assert.equal((await handleAdminList(req('/api/admin/letters', { cookie }), revoked, deps)).status, 401);
  });

  await t.test('다른 비밀값·위조 토큰은 거절', async () => {
    const parts = cookie.split('=')[1].split('.');
    const forged = `${ADMIN_COOKIE}=v1.${parts[1]}.${'A'.repeat(43)}`;
    assert.equal((await handleAdminList(req('/api/admin/letters', { cookie: forged }), ENV, deps)).status, 401);
    const otherSecret = { ...ENV, LETTER_COOKIE_SECRET: 'some-other-secret-0123456789abcdef-0123456789' };
    assert.equal((await handleAdminList(req('/api/admin/letters', { cookie }), otherSecret, deps)).status, 401);
  });

  await t.test('로그아웃', async () => {
    assert.equal((await handleAdminSession(req('/api/admin/session', { method: 'DELETE', origin: 'https://evil.example' }), ENV, deps)).status, 403);
    const res = await handleAdminSession(req('/api/admin/session', { method: 'DELETE', cookie }), ENV, deps);
    assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
  });

  await t.test('같은 출처·같은 이메일로 5번 틀리면 잠금 (맞는 비밀번호도 거절)', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await loginReq('admin@example.com', 'bad', 60)).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
    assert.equal((await loginReq('admin@example.com', 'right-password', 60)).status, 429);
    // 이메일 기준 잠금: 출처를 바꿔도 같은 계정은 잠김
    assert.equal((await loginReq('admin@example.com', 'right-password', 61)).status, 429);
    // 다른 계정·다른 출처는 영향 없음
    assert.equal((await loginReq('other@example.com', 'wrong', 62)).status, 401);
  });

  await t.test('Supabase Auth 장애는 503, 설정 누락은 500', async () => {
    const quiet = silenceErrors();
    try {
      const down = { ...deps, passwordLogin: async () => ({ ok: false, reason: 'unavailable' }) };
      const res = await handleAdminSession(req('/api/admin/session', { method: 'POST', body: { email: 'down@example.com', password: 'x' }, headers: ip(70) }), ENV, down);
      assert.equal(res.status, 503);
      const { ARISA_ADMIN_UIDS, ...noAdmin } = ENV;
      const miss = await handleAdminList(req('/api/admin/letters', { cookie }), noAdmin, deps);
      assert.equal(miss.status, 500);
      const badUid = await handleAdminList(req('/api/admin/letters', { cookie }), { ...ENV, ARISA_ADMIN_UIDS: `${ADMIN_UID}, not-a-uuid` }, deps);
      assert.equal(badUid.status, 500);
    } finally {
      quiet.restore();
    }
    assert.ok(!quiet.logs.join('\n').includes(ENV.SUPABASE_SERVICE_ROLE_KEY));
  });

  await db.close();
});

test('Supabase Auth 비밀번호 확인: 서버 키는 헤더로만, access token 은 버림', async () => {
  const calls = [];
  const make = (status, body) => createPasswordLogin(
    { supabaseUrl: 'https://p.supabase.co', serviceKey: 'eyJservice', anonKey: '' },
    async (url, init) => {
      calls.push({ url, init });
      if (status === 0) throw new TypeError('network');
      return new Response(JSON.stringify(body), { status });
    },
  );

  const ok = await make(200, { access_token: 'SECRET-ACCESS-TOKEN', refresh_token: 'SECRET-REFRESH', user: { id: ADMIN_UID.toUpperCase() } })('a@b.c', 'pw');
  assert.deepEqual(ok, { ok: true, userId: ADMIN_UID });
  assert.ok(!JSON.stringify(ok).includes('SECRET'));
  assert.equal(calls[0].url, 'https://p.supabase.co/auth/v1/token?grant_type=password');
  assert.equal(calls[0].init.headers.apikey, 'eyJservice');
  assert.ok(!calls[0].url.includes('eyJservice') && !calls[0].init.body.includes('eyJservice'));

  assert.deepEqual(await make(400, { error: 'invalid_grant' })('a@b.c', 'bad'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await make(500, {})('a@b.c', 'pw'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await make(0, {})('a@b.c', 'pw'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await make(200, { user: {} })('a@b.c', 'pw'), { ok: false, reason: 'unavailable' });

  const withAnon = createPasswordLogin({ supabaseUrl: 'https://p.supabase.co', serviceKey: 'eyJservice', anonKey: 'eyJanon' }, async (url, init) => {
    calls.push({ url, init });
    return new Response('{}', { status: 400 });
  });
  await withAnon('a@b.c', 'x');
  assert.equal(calls.at(-1).init.headers.apikey, 'eyJanon');
});
