import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, makeRpc, seedLetter } from './helpers/db.mjs';
import { ENV, ACCESS_CODE, ADMIN_UID, ORIGIN, cookieOf, req, silenceErrors } from './helpers/env.mjs';
import {
  handleReaderSession, handleReaderList, handleReaderLetter, handleReaderRead, READER_COOKIE,
} from '../server/reader-api.js';
import { handleAdminSession, handleAdminList, ADMIN_COOKIE } from '../server/admin-api.js';
import { createToken } from '../server/crypto.js';

const ip = (n) => ({ 'CF-Connecting-IP': `203.0.113.${n}` });
const login = (code, deps, n = 1, extra = {}) =>
  handleReaderSession(req('/api/arisa/session', { method: 'POST', body: { code }, headers: ip(n), ...extra }), ENV, deps);

test('아리사 편지함 API', async (t) => {
  const db = await createTestDb();
  const deps = { rpc: makeRpc(db) };
  const approved = await seedLetter(db, { name: '팬A', content: '<b>안녕</b> 아리사', status: 'approved', createdAt: '2026-10-01T00:00:00Z' });
  const approved2 = await seedLetter(db, { name: null, content: '두 번째 편지', status: 'approved', createdAt: '2026-10-02T00:00:00Z' });
  const pending = await seedLetter(db, { content: '검수 전 편지', status: 'pending' });
  const hidden = await seedLetter(db, { content: '숨긴 편지', status: 'hidden' });
  const readState = async (id) => (await db.query('select read_at from public.arisa_last_live_letters where id = $1', [id])).rows[0].read_at;

  let cookie;

  await t.test('로그인 전에는 모든 보호 API 가 401 (원문도 목록도 없음)', async () => {
    for (const res of [
      await handleReaderList(req('/api/arisa/letters'), ENV, deps),
      await handleReaderLetter(req(`/api/arisa/letters/${approved}`), ENV, approved, deps),
      await handleReaderRead(req(`/api/arisa/letters/${approved}/read`, { method: 'POST' }), ENV, approved, deps),
    ]) {
      assert.equal(res.status, 401);
      assert.ok(!(await res.text()).includes('안녕'));
    }
    assert.equal(await readState(approved), null);
    const s = await (await handleReaderSession(req('/api/arisa/session'), ENV, deps)).json();
    assert.equal(s.authenticated, false);
  });

  await t.test('틀린 코드는 401, 빈 값·너무 긴 값도 401', async () => {
    for (const code of ['wrong-code', '', '   ', 'x'.repeat(201)]) {
      const res = await login(code, deps);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, 'invalid_code');
      assert.equal(res.headers.get('Set-Cookie'), null);
    }
  });

  await t.test('로그인 요청은 같은 사이트·JSON 만 허용', async () => {
    assert.equal((await login(ACCESS_CODE, deps, 2, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await login(ACCESS_CODE, deps, 2, { origin: null })).status, 403);
    const text = await handleReaderSession(new Request(`${ORIGIN}/api/arisa/session`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain', ...ip(2) }, body: ACCESS_CODE,
    }), ENV, deps);
    assert.equal(text.status, 415);
  });

  await t.test('올바른 코드: 서버 서명 세션 쿠키 (HttpOnly · Strict · /api/arisa · Secure)', async () => {
    const res = await login(` ${ACCESS_CODE} `, deps, 3);
    assert.equal(res.status, 200);
    const set = res.headers.get('Set-Cookie');
    assert.match(set, new RegExp(`^${READER_COOKIE}=v1\\.`));
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /Path=\/api\/arisa/);
    assert.match(set, /Secure/);
    assert.match(set, /Max-Age=86400/);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    assert.ok(!set.includes(ACCESS_CODE));
    cookie = cookieOf(res, READER_COOKIE);
    const s = await (await handleReaderSession(req('/api/arisa/session', { cookie }), ENV, deps)).json();
    assert.equal(s.authenticated, true);
  });

  await t.test('목록: 승인된 편지만, 원문과 검수 상태는 담기지 않음', async () => {
    const res = await handleReaderList(req('/api/arisa/letters?filter=all&sort=asc&page=1', { cookie }), ENV, deps);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual(body.items.map((i) => i.id), [approved, approved2]);
    assert.deepEqual(body.counts, { total: 2, unread: 2, read: 0 });
    assert.deepEqual(Object.keys(body.items[0]).sort(), ['created_at', 'id', 'is_read', 'sender_name']);
    for (const secret of ['검수 전 편지', '숨긴 편지', '안녕', 'moderation_status', pending, hidden]) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  await t.test('상세: 승인된 편지만. 검수 전·숨김·없는 편지·잘못된 id 는 모두 404', async () => {
    for (const id of [pending, hidden, crypto.randomUUID(), 'not-a-uuid', "1'; drop table x;--"]) {
      const res = await handleReaderLetter(req(`/api/arisa/letters/${id}`, { cookie }), ENV, id, deps);
      assert.equal(res.status, 404, id);
    }
    const res = await handleReaderLetter(req(`/api/arisa/letters/${approved}?sort=asc`, { cookie }), ENV, approved, deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content, '<b>안녕</b> 아리사'); // 태그를 해석하지 않은 원문 그대로
    assert.equal(body.nextId, approved2);
    assert.equal(body.prevId, null);
    assert.ok(!('moderation_status' in body));
    assert.equal(await readState(approved), null, '상세 조회만으로는 읽음이 되지 않음');
  });

  await t.test('읽음 기록: 최초 1회만, 같은 사이트 요청만, 승인된 편지만', async () => {
    const send = (id, extra = {}) => handleReaderRead(req(`/api/arisa/letters/${id}/read`, { method: 'POST', cookie, ...extra }), ENV, id, deps);
    assert.equal((await send(approved, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await send(approved, { origin: null })).status, 403);
    assert.equal(await readState(approved), null);
    assert.equal((await send(pending)).status, 404);
    assert.equal((await send(hidden)).status, 404);
    assert.equal(await readState(pending), null);

    const first = await (await send(approved)).json();
    assert.ok(first.read_at);
    const again = await (await send(approved)).json();
    assert.equal(Date.parse(again.read_at), Date.parse(first.read_at));
    assert.equal(Date.parse(first.read_at), (await readState(approved)).getTime());

    const list = await (await handleReaderList(req('/api/arisa/letters?filter=unread', { cookie }), ENV, deps)).json();
    assert.deepEqual(list.items.map((i) => i.id), [approved2]);
    assert.deepEqual(list.counts, { total: 2, unread: 1, read: 1 });
  });

  await t.test('5번 틀리면 15분 잠금 (맞는 코드도 잠금 중에는 거절)', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await login('nope', deps, 77)).status);
    assert.deepEqual(results, [401, 401, 401, 401, 429]);
    const locked = await login(ACCESS_CODE, deps, 77);
    assert.equal(locked.status, 429);
    const body = await locked.json();
    assert.equal(body.code, 'locked');
    assert.ok(body.retryAfterSeconds > 800 && body.retryAfterSeconds <= 900);
    assert.ok(Number(locked.headers.get('Retry-After')) > 0);
    assert.equal(locked.headers.get('Set-Cookie'), null);
    // 다른 출처는 영향 없음
    assert.equal((await login(ACCESS_CODE, deps, 78)).status, 200);
  });

  await t.test('접근 코드가 바뀌면 이전 세션은 모두 무효', async () => {
    const changed = { ...ENV, ARISA_ACCESS_CODE: 'a-brand-new-access-code' };
    assert.equal((await handleReaderList(req('/api/arisa/letters', { cookie }), changed, deps)).status, 401);
    const bumped = { ...ENV, ARISA_AUTH_VERSION: '2' };
    assert.equal((await handleReaderList(req('/api/arisa/letters', { cookie }), bumped, deps)).status, 401);
    assert.equal((await handleReaderList(req('/api/arisa/letters', { cookie }), ENV, deps)).status, 200);
  });

  await t.test('위조·만료·다른 비밀값으로 만든 토큰은 거절', async () => {
    const parts = cookie.split('=')[1].split('.');
    const forged = `${READER_COOKIE}=v1.${parts[1]}.${'A'.repeat(43)}`;
    assert.equal((await handleReaderList(req('/api/arisa/letters', { cookie: forged }), ENV, deps)).status, 401);
    const label = `arisa:reader-session:v1|${ACCESS_CODE}|1`;
    const expired = await createToken({
      secret: ENV.LETTER_COOKIE_SECRET, label, claims: { aud: 'arisa_reader' }, ttlSeconds: 60, nowMs: Date.now() - 3600_000,
    });
    assert.equal((await handleReaderList(req('/api/arisa/letters', { cookie: `${READER_COOKIE}=${expired}` }), ENV, deps)).status, 401);
    const other = await createToken({
      secret: 'some-other-secret-0123456789abcdef-0123456789', label, claims: { aud: 'arisa_reader' }, ttlSeconds: 600,
    });
    assert.equal((await handleReaderList(req('/api/arisa/letters', { cookie: `${READER_COOKIE}=${other}` }), ENV, deps)).status, 401);
    const wrongAud = await createToken({ secret: ENV.LETTER_COOKIE_SECRET, label, claims: { aud: 'arisa_admin' }, ttlSeconds: 600 });
    assert.equal((await handleReaderList(req('/api/arisa/letters', { cookie: `${READER_COOKIE}=${wrongAud}` }), ENV, deps)).status, 401);
  });

  await t.test('관리자 세션으로는 아리사 편지함에 들어올 수 없고, 반대도 마찬가지 (완전 분리)', async () => {
    const adminDeps = { ...deps, passwordLogin: async () => ({ ok: true, userId: ADMIN_UID }) };
    const res = await handleAdminSession(req('/api/admin/session', {
      method: 'POST', body: { email: 'admin@example.com', password: 'pw' }, headers: ip(90),
    }), ENV, adminDeps);
    assert.equal(res.status, 200);
    const adminCookie = cookieOf(res, ADMIN_COOKIE);
    const value = adminCookie.split('=')[1];

    assert.equal((await handleReaderList(req('/api/arisa/letters', { cookie: adminCookie }), ENV, deps)).status, 401);
    assert.equal((await handleReaderList(req('/api/arisa/letters', { cookie: `${READER_COOKIE}=${value}` }), ENV, deps)).status, 401);
    assert.equal((await handleAdminList(req('/api/admin/letters', { cookie: cookie.replace(READER_COOKIE, ADMIN_COOKIE) }), ENV, deps)).status, 401);
    assert.equal((await handleAdminList(req('/api/admin/letters', { cookie: `${ADMIN_COOKIE}=${cookie.split('=')[1]}` }), ENV, deps)).status, 401);
  });

  await t.test('로그아웃: 쿠키 삭제 (같은 사이트 요청만)', async () => {
    assert.equal((await handleReaderSession(req('/api/arisa/session', { method: 'DELETE', origin: 'https://evil.example' }), ENV, deps)).status, 403);
    const res = await handleReaderSession(req('/api/arisa/session', { method: 'DELETE', cookie }), ENV, deps);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
  });

  await t.test('설정이 빠지면 500 이고 로그에 비밀값이 남지 않음', async () => {
    const quiet = silenceErrors();
    try {
      const { ARISA_ACCESS_CODE, ...noCode } = ENV;
      const res = await login(ACCESS_CODE, deps, 5, {});
      assert.equal(res.status, 200); // 정상 설정
      const bad = await handleReaderSession(req('/api/arisa/session', { method: 'POST', body: { code: 'x' } }), noCode, deps);
      assert.equal(bad.status, 500);
      assert.equal((await bad.json()).code, 'server_misconfigured');
      const short = await handleReaderList(req('/api/arisa/letters'), { ...ENV, ARISA_ACCESS_CODE: 'short' }, deps);
      assert.equal(short.status, 500);
    } finally {
      quiet.restore();
    }
    const joined = quiet.logs.join('\n');
    assert.ok(joined.includes('ARISA_ACCESS_CODE'));
    assert.ok(!joined.includes(ACCESS_CODE) && !joined.includes(ENV.SUPABASE_SERVICE_ROLE_KEY));
  });

  await t.test('DB 오류는 503, 원문이 로그에 남지 않음', async () => {
    const quiet = silenceErrors();
    let res;
    try {
      const login2 = await login(ACCESS_CODE, deps, 6);
      const c = cookieOf(login2, READER_COOKIE);
      const failing = { rpc: async () => { const e = new Error('boom'); e.status = 500; throw e; } };
      res = await handleReaderList(req('/api/arisa/letters', { cookie: c }), ENV, failing);
    } finally {
      quiet.restore();
    }
    assert.equal(res.status, 503);
    assert.ok(!quiet.logs.join('\n').includes('안녕'));
  });

  await db.close();
});
