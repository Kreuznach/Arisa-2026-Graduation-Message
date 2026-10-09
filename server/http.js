// 응답·쿠키·요청 검사 같은 공통 HTTP 도구
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 편지 원문·인증 응답은 어디에도 저장되지 않도록 no-store */
export function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function fail(status, code, extra = {}, headers = {}) {
  return json(status, { ok: false, code, ...extra }, headers);
}

export function methodNotAllowed(allow) {
  return fail(405, 'method_not_allowed', {}, { Allow: allow.join(', ') });
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function buildCookie(request, { name, value, path, maxAge, sameSite = 'Lax' }) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=${sameSite}${secure}`;
}

/** 같은 사이트에서 보낸 요청만 허용 (상태를 바꾸는 요청에 사용) */
export function isAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const allowed = new Set([new URL(request.url).origin]);
  for (const o of (env.LETTER_ALLOWED_ORIGINS || '').split(',')) if (o.trim()) allowed.add(o.trim());
  if (!allowed.has(origin)) return false;
  return request.headers.get('Sec-Fetch-Site') !== 'cross-site';
}

export function isJsonRequest(request) {
  return (request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json');
}

export async function readBodyLimited(request, max) {
  const len = request.headers.get('Content-Length');
  if (len !== null && (!/^\d+$/.test(len) || Number(len) > max)) return { tooLarge: true };
  if (!request.body) return { text: '' };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { invalid: true };
  }
}

/** 작은 JSON 객체 본문을 읽음. 실패하면 { response } 를 돌려줌 */
export async function readJsonObject(request, maxBytes) {
  const body = await readBodyLimited(request, maxBytes);
  if (body.tooLarge) return { response: fail(413, 'payload_too_large') };
  if (body.invalid) return { response: fail(400, 'invalid_request') };
  try {
    const value = JSON.parse(body.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { response: fail(400, 'invalid_request') };
    return { value };
  } catch {
    return { response: fail(400, 'invalid_request') };
  }
}

// 편지 원문·키·식별자는 기록하지 않고 상태 코드만 남김
export function logError(where, err) {
  console.error(`[arisa] ${where}`, err ? { status: err.status, code: err.code, name: err.name } : {});
}

/** 요청 출처(IP). Cloudflare 가 붙여 주는 헤더를 먼저 신뢰 */
export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}
