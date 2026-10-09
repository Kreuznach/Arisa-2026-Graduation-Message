// 서버 설정 읽기와 검사. 문제 설명에는 비밀값을 절대 넣지 않습니다.
export const MIGRATION_FILE = '20261009000000_create_arisa_last_live_letters.sql';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// legacy JWT 키의 payload(ref, role)만 읽음. 서명 검증은 Supabase 가 함
function readJwtPayload(key) {
  const part = key.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function readSupabaseUrl(env) {
  return env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL || '';
}

/** 편지 저장에 필요한 기본 설정 문제를 알려 주는 코드. 문제가 없으면 null */
export function findConfigProblem(env) {
  const supabaseUrl = readSupabaseUrl(env);
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = env.LETTER_COOKIE_SECRET;
  if (!supabaseUrl) return 'missing SUPABASE_URL';
  if (!serviceKey) return 'missing SUPABASE_SERVICE_ROLE_KEY';
  if (!secret) return 'missing LETTER_COOKIE_SECRET';
  if (secret.length < 32) return 'LETTER_COOKIE_SECRET shorter than 32 chars';
  let host;
  try {
    host = new URL(supabaseUrl).hostname;
  } catch {
    return 'SUPABASE_URL is not a valid URL';
  }
  if (serviceKey.startsWith('sb_publishable_')) return 'SUPABASE_SERVICE_ROLE_KEY is a publishable key, not a secret key';
  if (!serviceKey.startsWith('sb_')) {
    const payload = readJwtPayload(serviceKey);
    if (!payload) return 'SUPABASE_SERVICE_ROLE_KEY is not a valid key';
    if (payload.role !== 'service_role') return `SUPABASE_SERVICE_ROLE_KEY has role "${payload.role}", expected "service_role"`;
    const urlRef = host.endsWith('.supabase.co') ? host.split('.')[0] : null;
    if (urlRef && payload.ref && payload.ref !== urlRef) {
      return `SUPABASE_SERVICE_ROLE_KEY belongs to project "${payload.ref}" but SUPABASE_URL is project "${urlRef}"`;
    }
  }
  return null;
}

export function readConfig(env) {
  const problem = findConfigProblem(env);
  if (problem) {
    console.error(`[arisa] server misconfigured: ${problem}`);
    return null;
  }
  return {
    supabaseUrl: readSupabaseUrl(env).replace(/\/+$/, ''),
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: env.SUPABASE_ANON_KEY || '',
    secret: env.LETTER_COOKIE_SECRET,
  };
}

/** 아리사 편지함(접근 코드) 설정 문제. 문제가 없으면 null */
export function findReaderConfigProblem(env) {
  const code = env.ARISA_ACCESS_CODE;
  if (!code) return 'missing ARISA_ACCESS_CODE';
  if (code.length < 8) return 'ARISA_ACCESS_CODE shorter than 8 chars';
  return null;
}

/** 허용된 관리자 UID 목록 (소문자). 형식이 틀린 항목은 무시하지 않고 문제로 보고 */
export function parseAdminUids(env) {
  const raw = (env.ARISA_ADMIN_UIDS || '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { uids: new Set(raw.filter((u) => UUID_RE.test(u))), invalid: raw.filter((u) => !UUID_RE.test(u)).length };
}

/** 관리자 설정 문제. 문제가 없으면 null */
export function findAdminConfigProblem(env) {
  const { uids, invalid } = parseAdminUids(env);
  if (invalid > 0) return 'ARISA_ADMIN_UIDS contains an entry that is not a UUID';
  if (uids.size === 0) return 'missing ARISA_ADMIN_UIDS';
  return null;
}
