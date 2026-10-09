import { readConfig, findReaderConfigProblem } from './config.js';
import { createSupabaseRpc, describeRpcConfigError } from './supabase.js';
import { createToken, verifyToken, sha256Bytes, timingSafeEqual } from './crypto.js';
import { limitKey, lockSeconds, registerFailures, clearFailures } from './auth-limit.js';
import {
  json, fail, readCookie, buildCookie, isAllowedOrigin, isJsonRequest, readJsonObject, logError, clientIp, UUID_RE,
} from './http.js';

// 아리사 편지함 세션. 관리자 세션과 쿠키 이름·경로·서명 키·대상(aud)이 모두 다릅니다.
export const READER_COOKIE = 'arisa_reader_session';
const READER_PATH = '/api/arisa';
const AUDIENCE = 'arisa_reader';
const PAGE_SIZE = 12;

const sessionTtlSeconds = (env) => {
  const hours = Number(env.ARISA_SESSION_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600;
};

// 접근 코드나 버전이 바뀌면 서명 키도 바뀌어 이전 세션이 모두 무효가 됩니다.
const sessionLabel = (env) => `arisa:reader-session:v1|${env.ARISA_ACCESS_CODE}|${env.ARISA_AUTH_VERSION || '1'}`;

async function hasReaderSession(request, env, config) {
  const claims = await verifyToken({
    secret: config.secret, label: sessionLabel(env), token: readCookie(request, READER_COOKIE), aud: AUDIENCE,
  });
  return claims !== null;
}

function readerCookie(request, value, maxAge) {
  return buildCookie(request, { name: READER_COOKIE, value, path: READER_PATH, maxAge, sameSite: 'Strict' });
}

function rpcFailure(where, err) {
  const configError = describeRpcConfigError(err);
  if (configError) {
    console.error(`[arisa] server misconfigured: ${configError}`, { status: err.status, code: err.code });
    return fail(500, 'server_misconfigured');
  }
  logError(where, err);
  return fail(503, 'storage_unavailable');
}

// 설정 확인 → (필요하면) 같은 사이트 요청 확인 → (필요하면) 세션 확인
async function prepare(request, env, deps, { write = false, session = true } = {}) {
  if (write && !isAllowedOrigin(request, env)) return { response: fail(403, 'forbidden_origin') };
  const config = readConfig(env);
  const problem = config ? findReaderConfigProblem(env) : null;
  if (!config || problem) {
    if (problem) console.error(`[arisa] server misconfigured: ${problem}`);
    return { response: fail(500, 'server_misconfigured') };
  }
  if (session && !(await hasReaderSession(request, env, config))) return { response: fail(401, 'unauthorized') };
  return { config, rpc: deps.rpc || createSupabaseRpc(config) };
}

/* ---------- /api/arisa/session ---------- */
export async function handleReaderSession(request, env, deps = {}) {
  if (request.method === 'GET') {
    const ctx = await prepare(request, env, deps, { session: false });
    if (ctx.response) return ctx.response;
    return json(200, { ok: true, authenticated: await hasReaderSession(request, env, ctx.config) });
  }

  if (request.method === 'DELETE') {
    if (!isAllowedOrigin(request, env)) return fail(403, 'forbidden_origin');
    return json(200, { ok: true, authenticated: false }, { 'Set-Cookie': readerCookie(request, '', 0) });
  }

  // POST: 접근 코드 확인
  const ctx = await prepare(request, env, deps, { write: true, session: false });
  if (ctx.response) return ctx.response;
  if (!isJsonRequest(request)) return fail(415, 'unsupported_media_type');
  const body = await readJsonObject(request, 4 * 1024);
  if (body.response) return body.response;
  const code = typeof body.value.code === 'string' ? body.value.code : '';
  if (!code.trim() || code.length > 200) return fail(401, 'invalid_code');

  const { config, rpc } = ctx;
  try {
    const keys = [await limitKey(config.secret, 'reader-ip', clientIp(request))];
    const locked = await lockSeconds(rpc, keys);
    if (locked > 0) return fail(429, 'locked', { retryAfterSeconds: locked }, { 'Retry-After': String(locked) });

    const [given, expected] = await Promise.all([sha256Bytes(code.trim()), sha256Bytes(env.ARISA_ACCESS_CODE)]);
    if (!timingSafeEqual(given, expected)) {
      const nowLocked = await registerFailures(rpc, keys);
      if (nowLocked > 0) return fail(429, 'locked', { retryAfterSeconds: nowLocked }, { 'Retry-After': String(nowLocked) });
      return fail(401, 'invalid_code');
    }

    await clearFailures(rpc, keys);
    const ttl = sessionTtlSeconds(env);
    const token = await createToken({
      secret: config.secret, label: sessionLabel(env), claims: { aud: AUDIENCE }, ttlSeconds: ttl,
    });
    return json(200, { ok: true, authenticated: true }, { 'Set-Cookie': readerCookie(request, token, ttl) });
  } catch (err) {
    return rpcFailure('reader login rpc failed', err);
  }
}

/* ---------- 목록·상세 ---------- */
export function parseListParams(params) {
  const f = params.get('filter');
  const filter = f === 'unread' || f === 'read' ? f : 'all';
  const sort = params.get('sort') === 'asc' ? 'asc' : 'desc';
  const page = Math.min(100000, Math.max(1, Math.floor(Number(params.get('page'))) || 1));
  return { filter, sort, page };
}

export async function handleReaderList(request, env, deps = {}) {
  const ctx = await prepare(request, env, deps);
  if (ctx.response) return ctx.response;
  const { filter, sort, page } = parseListParams(new URL(request.url).searchParams);
  try {
    const r = await ctx.rpc('arisa_list_letters', { p_filter: filter, p_sort: sort, p_page: page, p_page_size: PAGE_SIZE });
    return json(200, {
      ok: true,
      counts: { total: r.counts.total, unread: r.counts.unread, read: r.counts.read },
      page: r.page,
      totalPages: r.total_pages,
      items: r.items.map((i) => ({ id: i.id, sender_name: i.sender_name, created_at: i.created_at, is_read: i.is_read })),
    });
  } catch (err) {
    return rpcFailure('reader list rpc failed', err);
  }
}

export async function handleReaderLetter(request, env, id, deps = {}) {
  const ctx = await prepare(request, env, deps);
  if (ctx.response) return ctx.response;
  if (!UUID_RE.test(id)) return fail(404, 'not_found');
  const { filter, sort } = parseListParams(new URL(request.url).searchParams);
  try {
    const r = await ctx.rpc('arisa_get_letter', { p_id: id, p_filter: filter, p_sort: sort });
    if (!r) return fail(404, 'not_found');
    return json(200, {
      ok: true,
      id: r.id,
      sender_name: r.sender_name,
      content: r.content,
      created_at: r.created_at,
      read_at: r.read_at,
      prevId: r.prev_id,
      nextId: r.next_id,
    });
  } catch (err) {
    return rpcFailure('reader letter rpc failed', err);
  }
}

// 아리사 세션이 있어야만 읽음을 기록한다. body/query 의 값은 보지 않는다.
export async function handleReaderRead(request, env, id, deps = {}) {
  const ctx = await prepare(request, env, deps, { write: true });
  if (ctx.response) return ctx.response;
  if (!UUID_RE.test(id)) return fail(404, 'not_found');
  try {
    const r = await ctx.rpc('arisa_mark_letter_read', { p_id: id });
    if (!r || !r.read_at) return fail(404, 'not_found');
    return json(200, { ok: true, id, read_at: r.read_at });
  } catch (err) {
    return rpcFailure('reader read rpc failed', err);
  }
}
