import { MIGRATION_FILE } from './config.js';

// 일시 장애가 아니라 설정을 고쳐야 하는 Supabase 응답
export function describeRpcConfigError(err) {
  if (!err) return null;
  if (err.status === 401 || (err.status === 403 && err.code !== '42501')) {
    return 'Supabase rejected SUPABASE_SERVICE_ROLE_KEY (wrong project, revoked, or not a service key)';
  }
  if (err.code === 'PGRST202' || err.code === '42883') return `arisa RPC not found: apply supabase/migrations/${MIGRATION_FILE}`;
  if (err.code === '42501') return 'permission denied: key is not service_role or migration grants are missing';
  return null;
}

// 서버에서 service role/secret 키로 PostgREST RPC 호출. 키는 응답·로그에 남기지 않음
export function createSupabaseRpc({ supabaseUrl, serviceKey }, fetchImpl = fetch) {
  return async function rpc(name, args) {
    const headers = { apikey: serviceKey, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (!serviceKey.startsWith('sb_')) headers.Authorization = `Bearer ${serviceKey}`;
    const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      let code = '';
      try { code = (await res.json()).code || ''; } catch { /* 본문 없음 */ }
      const err = new Error(`rpc ${name} failed`);
      err.status = res.status;
      err.code = code;
      throw err;
    }
    // 반환값이 없는 함수(void)는 본문이 비어 있을 수 있음
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

/**
 * Supabase Auth 이메일·비밀번호 확인. 서버에서만 호출하며 access token 은 브라우저로 보내지 않습니다.
 * @returns {Promise<{ ok: true, userId: string } | { ok: false, reason: 'invalid' | 'unavailable' }>}
 */
export function createPasswordLogin({ supabaseUrl, serviceKey, anonKey }, fetchImpl = fetch) {
  return async function passwordLogin(email, password) {
    const apikey = anonKey || serviceKey;
    let res;
    try {
      res = await fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (res.status === 400 || res.status === 401 || res.status === 422) return { ok: false, reason: 'invalid' };
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    try {
      const data = await res.json();
      const id = data && data.user && typeof data.user.id === 'string' ? data.user.id.toLowerCase() : '';
      return id ? { ok: true, userId: id } : { ok: false, reason: 'unavailable' };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  };
}
