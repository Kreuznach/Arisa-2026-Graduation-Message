// 배포 전에 설정이 맞는지 확인합니다. 비밀값은 출력하지 않습니다.
// 사용: npm run check:config            (.dev.vars 를 읽음)
//       npm run check:config -- 파일경로
import { readFileSync, existsSync } from 'node:fs';
import {
  findConfigProblem, findReaderConfigProblem, findAdminConfigProblem, readSupabaseUrl, parseAdminUids, MIGRATION_FILE,
} from '../server/config.js';
import { describeRpcConfigError, createSupabaseRpc } from '../server/supabase.js';

const file = process.argv[2] || '.dev.vars';
const env = { ...process.env };
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log(`읽은 파일: ${file}`);
} else {
  console.log(`${file} 이 없어 환경변수만 사용합니다.`);
}

let failed = false;
const fail = (text) => { console.error(`✗ ${text}`); failed = true; };

const problem = findConfigProblem(env);
if (problem) {
  fail(`기본 설정 오류: ${problem}`);
  process.exit(1);
}
const supabaseUrl = readSupabaseUrl(env).replace(/\/+$/, '');
console.log(`✓ 기본 설정 형식 통과 (프로젝트: ${new URL(supabaseUrl).hostname})`);

const readerProblem = findReaderConfigProblem(env);
if (readerProblem) fail(`아리사 편지함 설정 오류: ${readerProblem}  → /arisa 가 열리지 않아요`);
else console.log('✓ 아리사 접근 코드 설정됨 (값은 출력하지 않아요)');

const adminProblem = findAdminConfigProblem(env);
if (adminProblem) fail(`관리자 설정 오류: ${adminProblem}  → /admin 에 로그인할 수 없어요`);
else console.log(`✓ 허용된 관리자 UID ${parseAdminUids(env).uids.size}개 설정됨`);

const rpc = createSupabaseRpc({ supabaseUrl, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY });
try {
  const r = await rpc('arisa_get_submit_status', { p_browser_hash: '0'.repeat(64) });
  console.log(`✓ Supabase 연결 성공, 아리사 테이블/함수 확인 (DB 시각 ${new Date(Number(r.server_now_ms)).toISOString()})`);
} catch (err) {
  if (err.code === 'PGRST202' || err.code === '42883') {
    fail(`Supabase 키는 맞지만 아리사 마이그레이션이 아직 적용되지 않았어요. supabase/migrations/${MIGRATION_FILE} 를 SQL Editor 에서 실행해 주세요.`);
  } else {
    const reason = describeRpcConfigError(err) || 'Supabase 가 일시적으로 응답하지 않음';
    fail(`Supabase 호출 실패 (HTTP ${err.status ?? '-'} ${err.code || ''}): ${reason}`);
  }
}

if (failed) process.exitCode = 1;
else console.log('모든 확인을 통과했어요. 이 값 그대로 Cloudflare Pages 에 넣으면 됩니다.');
