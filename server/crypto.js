// Web Crypto 로 서명·해시를 만드는 도구 모음. 아리사 서비스의 모든 비밀값은 label 로 서로 분리합니다.
const encoder = new TextEncoder();
const keyCache = new Map();

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 같은 secret 이라도 label 이 다르면 완전히 다른 키가 됩니다. (예: 팬 쿠키 / 아리사 세션 / 관리자 세션)
function deriveKey(secret, label) {
  const cacheKey = `${label}\u0000${secret}`;
  if (!keyCache.has(cacheKey)) {
    keyCache.set(cacheKey, (async () => {
      const root = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const material = await crypto.subtle.sign('HMAC', root, encoder.encode(label));
      return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    })());
  }
  return keyCache.get(cacheKey);
}

export async function hmacBytes(secret, label, message) {
  return crypto.subtle.sign('HMAC', await deriveKey(secret, label), encoder.encode(message));
}

export async function hmacHex(secret, label, message) {
  return toHex(await hmacBytes(secret, label, message));
}

export async function hmacVerify(secret, label, signature, message) {
  return crypto.subtle.verify('HMAC', await deriveKey(secret, label), signature, encoder.encode(message));
}

export async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

// 길이가 같은 두 바이트열을 끝까지 비교 (중간에 멈추지 않음)
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const TOKEN_RE = /^v1\.([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/;

/** 서명된 세션 토큰. claims 에는 aud(대상) 가 반드시 있어야 합니다. */
export async function createToken({ secret, label, claims, ttlSeconds, nowMs = Date.now() }) {
  const iat = Math.floor(nowMs / 1000);
  const payload = toBase64Url(encoder.encode(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds })));
  const sig = await hmacBytes(secret, label, `token:v1:${payload}`);
  return `v1.${payload}.${toBase64Url(sig)}`;
}

/** 서명·대상(aud)·만료를 모두 확인하고, 통과하면 claims 를 돌려줍니다. 아니면 null */
export async function verifyToken({ secret, label, token, aud, nowMs = Date.now() }) {
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  if (!m) return null;
  try {
    const ok = await hmacVerify(secret, label, fromBase64Url(m[2]), `token:v1:${m[1]}`);
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(m[1])));
    if (!claims || claims.aud !== aud || !(claims.exp > Math.floor(nowMs / 1000))) return null;
    return claims;
  } catch {
    return null;
  }
}
