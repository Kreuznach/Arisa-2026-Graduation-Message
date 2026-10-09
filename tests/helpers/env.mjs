export const ORIGIN = 'https://arisa.example';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export const ADMIN_UID = '3f1c9a52-7b8e-4d2a-9c61-0a5e2f7d4b18';
export const OTHER_UID = '8d2e6b14-5a3c-4f70-b9d2-1c4e7a9f3e65';
export const ACCESS_CODE = 'test-access-code-9z8y';

export const ENV = Object.freeze({
  SUPABASE_URL: 'https://project.supabase.example',
  SUPABASE_SERVICE_ROLE_KEY: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: 'supabase', ref: 'project', role: 'service_role' })}.signature-never-leaks`,
  LETTER_COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef-0123456789',
  ARISA_ACCESS_CODE: ACCESS_CODE,
  ARISA_ADMIN_UIDS: ADMIN_UID,
});

export function cookieOf(res, name) {
  const set = res.headers.get('Set-Cookie') || '';
  const m = new RegExp(`${name}=([^;]*)`).exec(set);
  return m && m[1] ? `${name}=${m[1]}` : null;
}

export function req(path, { method = 'GET', body, cookie, origin = ORIGIN, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (method !== 'GET') {
    if (origin) h.Origin = origin;
    if (body !== undefined) h['Content-Type'] = 'application/json';
  }
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function silenceErrors() {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(JSON.stringify(args));
  return { logs, restore: () => { console.error = original; } };
}
