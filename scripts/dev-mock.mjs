// 가짜 Supabase + 로컬 Cloudflare Pages 를 한 번에 켭니다. (실제 Supabase 는 건드리지 않음)
// 사용: npm run dev:mock   →   http://127.0.0.1:8788
import { spawn } from 'node:child_process';
import { startMockSupabase, MOCK_ADMIN } from './mock-supabase.mjs';

const MOCK_PORT = Number(process.env.MOCK_SUPABASE_PORT || 54321);
const PAGES_PORT = Number(process.env.PORT || 8788);
const MOCK_ACCESS_CODE = 'mock-access-code';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeServiceKey = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', ref: 'mock', role: 'service_role' })}.mock-signature`;

const mock = await startMockSupabase({ port: MOCK_PORT, seed: true });

const bindings = {
  SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  SUPABASE_SERVICE_ROLE_KEY: fakeServiceKey,
  LETTER_COOKIE_SECRET: 'mock-cookie-secret-0123456789abcdef-0123456789',
  ARISA_ACCESS_CODE: MOCK_ACCESS_CODE,
  ARISA_ADMIN_UIDS: MOCK_ADMIN.userId,
};

const args = ['node_modules/wrangler/bin/wrangler.js', 'pages', 'dev', '--port', String(PAGES_PORT), '--ip', '127.0.0.1'];
for (const [k, v] of Object.entries(bindings)) args.push('--binding', `${k}=${v}`);

console.log('');
console.log(`편지 쓰기      http://127.0.0.1:${PAGES_PORT}/`);
console.log(`아리사 편지함  http://127.0.0.1:${PAGES_PORT}/arisa   (접근 코드: ${MOCK_ACCESS_CODE})`);
console.log(`관리자         http://127.0.0.1:${PAGES_PORT}/admin   (${MOCK_ADMIN.email} / ${MOCK_ADMIN.password})`);
console.log(`현장 안내      http://127.0.0.1:${PAGES_PORT}/display`);
console.log('(위 코드와 계정은 가짜 DB 용 연습값이에요. 진짜 값이 아니에요.)');
console.log('');

const child = spawn(process.execPath, args, { stdio: 'inherit' });
const stop = async () => {
  child.kill();
  await mock.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', stop);
