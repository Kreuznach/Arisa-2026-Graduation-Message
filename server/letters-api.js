import { validateLetter } from '../public/assets/letter-rules.js';
import { readConfig } from './config.js';
import { createSupabaseRpc, describeRpcConfigError } from './supabase.js';
import { hmacBytes, hmacHex, hmacVerify, toBase64Url, fromBase64Url } from './crypto.js';
import {
  json, fail, readCookie, buildCookie, isAllowedOrigin, isJsonRequest, readBodyLimited, logError, UUID_RE,
} from './http.js';

// 팬 브라우저 식별 쿠키 (48시간 제한용). 아리사 편지함·관리자 쿠키와 이름·경로·서명 키가 모두 다릅니다.
export const COOKIE_NAME = 'arisa_letter_bid';
const COOKIE_PATH = '/api/letters';
// 48시간 제한보다 충분히 길게 (브라우저 상한 400일)
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
// 256KiB 본문의 JSON 이스케이프 여유분 포함
export const MAX_BODY_BYTES = 640 * 1024;

const COOKIE_VALUE_RE = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const ALLOWED_FIELDS = new Set(['senderName', 'content', 'idempotencyKey']);
const SIGN_LABEL = 'arisa:fan-cookie:v1';
const HASH_LABEL = 'arisa:fan-hash:v1';

async function issueBrowserId(secret) {
  const id = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const sig = await hmacBytes(secret, SIGN_LABEL, `bid:v1:${id}`);
  return { id, cookieValue: `v1.${id}.${toBase64Url(sig)}` };
}

async function verifyBrowserId(cookieValue, secret) {
  const m = cookieValue && COOKIE_VALUE_RE.exec(cookieValue);
  if (!m) return null;
  const ok = await hmacVerify(secret, SIGN_LABEL, fromBase64Url(m[2]), `bid:v1:${m[1]}`);
  return ok ? m[1] : null;
}

// DB 에는 원래 식별자 대신 서버 비밀값으로 만든 해시만 저장
const browserHash = (id, secret) => hmacHex(secret, HASH_LABEL, `hash:v1:${id}`);

const cookieHeader = (request, value) =>
  buildCookie(request, { name: COOKIE_NAME, value, path: COOKIE_PATH, maxAge: COOKIE_MAX_AGE });

async function resolveBrowser(request, secret) {
  const value = readCookie(request, COOKIE_NAME);
  const id = await verifyBrowserId(value, secret);
  if (id) return { id, cookieValue: value, issued: false };
  return { ...(await issueBrowserId(secret)), issued: true };
}

function rpcFailure(where, err, headers = {}) {
  const configError = describeRpcConfigError(err);
  if (configError) {
    console.error(`[arisa] server misconfigured: ${configError}`, { status: err.status, code: err.code });
    return fail(500, 'server_misconfigured', {}, headers);
  }
  logError(where, err);
  return fail(503, 'storage_unavailable', {}, headers);
}

/* ---------- GET /api/letters/status ---------- */
export async function handleStatus(request, env, deps = {}) {
  const config = readConfig(env);
  if (!config) return fail(500, 'server_misconfigured');
  const browser = await resolveBrowser(request, config.secret);
  const setCookie = { 'Set-Cookie': cookieHeader(request, browser.cookieValue) };

  if (browser.issued) {
    return json(200, { ok: true, canSubmit: true, nextAllowedAt: null, serverNow: new Date().toISOString() }, setCookie);
  }

  const rpc = deps.rpc || createSupabaseRpc(config);
  try {
    const r = await rpc('arisa_get_submit_status', { p_browser_hash: await browserHash(browser.id, config.secret) });
    const next = r.next_allowed_at_ms == null ? null : Number(r.next_allowed_at_ms);
    return json(200, {
      ok: true,
      canSubmit: next === null,
      nextAllowedAt: next === null ? null : new Date(next).toISOString(),
      serverNow: new Date(Number(r.server_now_ms)).toISOString(),
    }, setCookie);
  } catch (err) {
    return rpcFailure('status rpc failed', err, setCookie);
  }
}

/* ---------- POST /api/letters ---------- */
export async function handleSubmit(request, env, deps = {}) {
  if (!isAllowedOrigin(request, env)) return fail(403, 'forbidden_origin');
  if (!isJsonRequest(request)) return fail(415, 'unsupported_media_type');

  const config = readConfig(env);
  if (!config) return fail(500, 'server_misconfigured');

  // 클라이언트가 보낸 식별자는 믿지 않음. 서버 서명이 맞는 쿠키가 없으면 새로 발급하고 저장은 거절
  const browser = await resolveBrowser(request, config.secret);
  if (browser.issued) {
    return fail(428, 'browser_cookie_required', {}, { 'Set-Cookie': cookieHeader(request, browser.cookieValue) });
  }

  const body = await readBodyLimited(request, MAX_BODY_BYTES);
  if (body.tooLarge) return fail(413, 'payload_too_large');
  if (body.invalid) return fail(400, 'invalid_request');

  let payload;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return fail(400, 'invalid_request');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some((k) => !ALLOWED_FIELDS.has(k))) {
    return fail(400, 'invalid_request');
  }

  const key = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey.toLowerCase() : '';
  if (!UUID_RE.test(key)) return fail(400, 'invalid_request');

  const checked = validateLetter(payload);
  if (!checked.ok) return fail(400, 'validation_failed', { fields: checked.errors });

  const rpc = deps.rpc || createSupabaseRpc(config);
  let r;
  try {
    r = await rpc('arisa_submit_letter', {
      p_browser_hash: await browserHash(browser.id, config.secret),
      p_idempotency_key: key,
      p_sender_name: checked.value.senderName,
      p_content: checked.value.content,
    });
  } catch (err) {
    return rpcFailure('submit rpc failed', err);
  }

  const nextMs = Number(r.next_allowed_at_ms);
  const nowMs = Number(r.server_now_ms);
  const times = { nextAllowedAt: new Date(nextMs).toISOString(), serverNow: new Date(nowMs).toISOString() };

  if (r.status === 'limited') {
    const retryAfter = Math.max(1, Math.ceil((nextMs - nowMs) / 1000));
    return fail(429, 'rate_limited', times, { 'Retry-After': String(retryAfter) });
  }
  if (r.status === 'created' || r.status === 'replayed') {
    return json(r.status === 'created' ? 201 : 200, { ok: true, status: r.status, ...times });
  }
  logError('submit rpc unexpected result', { name: 'UnexpectedStatus' });
  return fail(503, 'storage_unavailable');
}
