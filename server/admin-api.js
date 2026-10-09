import { readConfig, findAdminConfigProblem, parseAdminUids } from './config.js';
import { createSupabaseRpc, createPasswordLogin, describeRpcConfigError } from './supabase.js';
import { createToken, verifyToken } from './crypto.js';
import { limitKey, lockSeconds, registerFailures, clearFailures } from './auth-limit.js';
import {
  json, fail, readCookie, buildCookie, isAllowedOrigin, isJsonRequest, readJsonObject, logError, clientIp, UUID_RE,
} from './http.js';

// 관리자 세션. 아리사 편지함 세션과 쿠키 이름·경로·서명 키·대상(aud)이 모두 다릅니다.
export const ADMIN_COOKIE = 'arisa_admin_session';
const ADMIN_PATH = '/api/admin';
const AUDIENCE = 'arisa_admin';
const LABEL = 'arisa:admin-session:v1';
const SESSION_SECONDS = 8 * 3600;
const PAGE_SIZE = 20;
const STATUSES = new Set(['pending', 'approved', 'hidden']);

const adminCookie = (request, value, maxAge) =>
  buildCookie(request, { name: ADMIN_COOKIE, value, path: ADMIN_PATH, maxAge, sameSite: 'Strict' });

function rpcFailure(where, err) {
  const configError = describeRpcConfigError(err);
  if (configError) {
    console.error(`[arisa] server misconfigured: ${configError}`, { status: err.status, code: err.code });
    return fail(500, 'server_misconfigured');
  }
  logError(where, err);
  return fail(503, 'storage_unavailable');
}

// 서명이 맞고 만료 전이며, 지금도 허용 목록에 있는 관리자 UID 인지 매 요청마다 확인
async function currentAdmin(request, env, config) {
  const claims = await verifyToken({
    secret: config.secret, label: LABEL, token: readCookie(request, ADMIN_COOKIE), aud: AUDIENCE,
  });
  if (!claims || typeof claims.sub !== 'string') return null;
  return parseAdminUids(env).uids.has(claims.sub) ? claims.sub : null;
}

async function prepare(request, env, deps, { write = false, session = true } = {}) {
  if (write && !isAllowedOrigin(request, env)) return { response: fail(403, 'forbidden_origin') };
  const config = readConfig(env);
  const problem = config ? findAdminConfigProblem(env) : null;
  if (!config || problem) {
    if (problem) console.error(`[arisa] server misconfigured: ${problem}`);
    return { response: fail(500, 'server_misconfigured') };
  }
  let adminId = null;
  if (session) {
    adminId = await currentAdmin(request, env, config);
    if (!adminId) return { response: fail(401, 'unauthorized') };
  }
  return { config, adminId, rpc: deps.rpc || createSupabaseRpc(config) };
}

/* ---------- /api/admin/session ---------- */
export async function handleAdminSession(request, env, deps = {}) {
  if (request.method === 'GET') {
    const ctx = await prepare(request, env, deps, { session: false });
    if (ctx.response) return ctx.response;
    return json(200, { ok: true, authenticated: (await currentAdmin(request, env, ctx.config)) !== null });
  }

  if (request.method === 'DELETE') {
    if (!isAllowedOrigin(request, env)) return fail(403, 'forbidden_origin');
    return json(200, { ok: true, authenticated: false }, { 'Set-Cookie': adminCookie(request, '', 0) });
  }

  // POST: 이메일·비밀번호 로그인
  const ctx = await prepare(request, env, deps, { write: true, session: false });
  if (ctx.response) return ctx.response;
  if (!isJsonRequest(request)) return fail(415, 'unsupported_media_type');
  const body = await readJsonObject(request, 4 * 1024);
  if (body.response) return body.response;

  const email = typeof body.value.email === 'string' ? body.value.email.trim().toLowerCase() : '';
  const password = typeof body.value.password === 'string' ? body.value.password : '';
  if (!email || email.length > 254 || !email.includes('@') || !password || password.length > 200) {
    return fail(401, 'invalid_credentials');
  }

  const { config, rpc } = ctx;
  const login = deps.passwordLogin || createPasswordLogin(config);
  try {
    const keys = [
      await limitKey(config.secret, 'admin-ip', clientIp(request)),
      await limitKey(config.secret, 'admin-email', email),
    ];
    const locked = await lockSeconds(rpc, keys);
    if (locked > 0) return fail(429, 'locked', { retryAfterSeconds: locked }, { 'Retry-After': String(locked) });

    const result = await login(email, password);
    if (!result.ok && result.reason === 'unavailable') return fail(503, 'auth_unavailable');

    // 비밀번호가 틀렸거나, 맞아도 허용된 관리자 UID 가 아니면 같은 응답 (어느 쪽인지 알려 주지 않음)
    if (!result.ok || !parseAdminUids(env).uids.has(result.userId)) {
      const nowLocked = await registerFailures(rpc, keys);
      if (nowLocked > 0) return fail(429, 'locked', { retryAfterSeconds: nowLocked }, { 'Retry-After': String(nowLocked) });
      return fail(401, 'invalid_credentials');
    }

    await clearFailures(rpc, keys);
    const token = await createToken({
      secret: config.secret, label: LABEL, claims: { aud: AUDIENCE, sub: result.userId }, ttlSeconds: SESSION_SECONDS,
    });
    return json(200, { ok: true, authenticated: true }, { 'Set-Cookie': adminCookie(request, token, SESSION_SECONDS) });
  } catch (err) {
    return rpcFailure('admin login rpc failed', err);
  }
}

/* ---------- 목록·상세·상태 변경 ---------- */
export function parseAdminListParams(params) {
  const s = params.get('status');
  const status = STATUSES.has(s) ? s : 'all';
  const q = (params.get('q') || '').trim().slice(0, 100);
  const page = Math.min(100000, Math.max(1, Math.floor(Number(params.get('page'))) || 1));
  return { status, q, page };
}

export async function handleAdminList(request, env, deps = {}) {
  const ctx = await prepare(request, env, deps);
  if (ctx.response) return ctx.response;
  const { status, q, page } = parseAdminListParams(new URL(request.url).searchParams);
  try {
    const r = await ctx.rpc('arisa_admin_list_letters', { p_status: status, p_search: q, p_page: page, p_page_size: PAGE_SIZE });
    return json(200, {
      ok: true,
      counts: r.counts,
      page: r.page,
      totalPages: r.total_pages,
      items: r.items,
    });
  } catch (err) {
    return rpcFailure('admin list rpc failed', err);
  }
}

// 미리보기: 상태와 상관없이 한 통을 돌려주지만 읽음은 기록하지 않는다 (read_at 을 바꾸는 호출이 없음)
export async function handleAdminLetter(request, env, id, deps = {}) {
  const ctx = await prepare(request, env, deps);
  if (ctx.response) return ctx.response;
  if (!UUID_RE.test(id)) return fail(404, 'not_found');
  try {
    const r = await ctx.rpc('arisa_admin_get_letter', { p_id: id });
    if (!r) return fail(404, 'not_found');
    return json(200, { ok: true, ...r });
  } catch (err) {
    return rpcFailure('admin letter rpc failed', err);
  }
}

export async function handleAdminSetStatus(request, env, id, deps = {}) {
  const ctx = await prepare(request, env, deps, { write: true });
  if (ctx.response) return ctx.response;
  if (!isJsonRequest(request)) return fail(415, 'unsupported_media_type');
  if (!UUID_RE.test(id)) return fail(404, 'not_found');
  const body = await readJsonObject(request, 1024);
  if (body.response) return body.response;
  const keys = Object.keys(body.value);
  if (keys.length !== 1 || keys[0] !== 'status' || !STATUSES.has(body.value.status)) return fail(400, 'invalid_request');
  try {
    const r = await ctx.rpc('arisa_admin_set_status', { p_id: id, p_status: body.value.status });
    if (!r) return fail(404, 'not_found');
    return json(200, { ok: true, id: r.id, moderation_status: r.moderation_status, reviewed_at: r.reviewed_at });
  } catch (err) {
    return rpcFailure('admin status rpc failed', err);
  }
}
