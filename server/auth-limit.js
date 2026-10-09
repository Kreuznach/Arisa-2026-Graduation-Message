import { hmacHex } from './crypto.js';

// 로그인 실패 제한: 15분 안에 5번 틀리면 15분 동안 잠김 (아리사 접근 코드와 관리자 로그인 공통)
export const FAIL_LIMIT = Object.freeze({ windowSeconds: 15 * 60, max: 5 });

/** 원본 IP·이메일 대신 서버 비밀값으로 만든 해시를 DB 키로 사용. scope 가 다르면 서로 섞이지 않음 */
export const limitKey = (secret, scope, value) => hmacHex(secret, 'arisa:rate-limit:v1', `${scope}:${value}`);

const args = (key) => ({ p_key: key, p_window_seconds: FAIL_LIMIT.windowSeconds, p_max: FAIL_LIMIT.max });

/** 키 중 하나라도 잠겨 있으면 가장 긴 남은 초, 아니면 0 */
export async function lockSeconds(rpc, keys) {
  let longest = 0;
  for (const key of keys) longest = Math.max(longest, Number(await rpc('arisa_auth_lock_seconds', args(key))) || 0);
  return longest;
}

/** 실패를 기록하고, 잠금 상태가 됐으면 남은 초를 돌려줌 */
export async function registerFailures(rpc, keys) {
  let longest = 0;
  for (const key of keys) longest = Math.max(longest, Number(await rpc('arisa_auth_register_failure', args(key))) || 0);
  return longest;
}

export async function clearFailures(rpc, keys) {
  for (const key of keys) await rpc('arisa_auth_clear_failures', { p_key: key });
}
