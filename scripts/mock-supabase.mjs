// 로컬 확인용 가짜 Supabase. 실제 마이그레이션 SQL을 PGlite(메모리 Postgres)에 적용하고
// /rest/v1/rpc/<함수> 를 service_role 권한으로 실행합니다. 127.0.0.1 에서만 열립니다.
// 관리자 로그인(/auth/v1/token)도 흉내 냅니다. 진짜 Supabase 나 모카 데이터에는 아무 영향이 없습니다.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTestDb, makeRpc, seedLetter } from '../tests/helpers/db.mjs';

export const MOCK_ADMIN = Object.freeze({
  email: 'admin@arisa.test',
  password: 'mock-admin-password',
  userId: '3f1c9a52-7b8e-4d2a-9c61-0a5e2f7d4b18',
});

const SAMPLE_LETTERS = [
  ['하나', '아리사, 마지막 무대까지 정말 고마웠어요.\n처음 만난 날부터 오늘까지 매일이 반짝였어요.', 'approved', false],
  [null, '익명으로 남겨요.\n\n항상 웃게 해줘서 고마워요. 핑크빛 기억은 오래 남을 거예요.', 'approved', false],
  ['다온', '긴 편지 연습입니다.\n' + Array.from({ length: 40 }, (_, i) => `${i + 1}번째 줄: 아리사가 들려준 노래를 오래오래 기억할게요.`).join('\n'), 'approved', true],
  ['미리', '검수를 기다리는 편지예요.', 'pending', false],
  ['노을', '이 편지는 숨김 처리되었어요.', 'hidden', false],
  ['소라', '<b>태그</b>처럼 보여도 글자 그대로 보여야 해요. 💖🥹', 'pending', false],
];

/** @returns {Promise<{ port: number, db: import('@electric-sql/pglite').PGlite, close: () => Promise<void> }>} */
export async function startMockSupabase({ port = Number(process.env.MOCK_SUPABASE_PORT || 54321), seed = false, quiet = false } = {}) {
  const db = await createTestDb();
  const rpc = makeRpc(db);
  let failNext = 0;

  if (seed) {
    for (let i = 0; i < SAMPLE_LETTERS.length; i++) {
      const [name, content, status, read] = SAMPLE_LETTERS[i];
      await seedLetter(db, { name, content, status, read, createdAt: new Date(Date.now() - (SAMPLE_LETTERS.length - i) * 3600_000).toISOString() });
    }
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        if (!req.headers.apikey) return send(res, 401, { code: 'no_api_key' });
        if (!m[1].startsWith('arisa_')) return send(res, 404, { code: 'PGRST202' });
        if (failNext > 0) {
          failNext--;
          return send(res, 500, { code: 'mock_failure' });
        }
        return send(res, 200, await rpc(m[1], await readJson(req)));
      }
      if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
        const body = await readJson(req);
        if (body.email === MOCK_ADMIN.email && body.password === MOCK_ADMIN.password) {
          return send(res, 200, { access_token: 'mock-access-token', token_type: 'bearer', user: { id: MOCK_ADMIN.userId } });
        }
        return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      }
      // 시간 여행: 모든 제한 시각을 N시간 앞당김 (48시간 경계 확인용)
      if (req.method === 'POST' && url.pathname === '/__mock/shift') {
        const hours = Number(url.searchParams.get('hours') || 48);
        const ms = Number(url.searchParams.get('ms') || 0);
        await db.query(
          `update public.arisa_letter_submission_limits
           set last_success_at = last_success_at - make_interval(hours => $1::int) - make_interval(secs => $2::float8 / 1000),
               next_allowed_at = next_allowed_at - make_interval(hours => $1::int) - make_interval(secs => $2::float8 / 1000)
           where next_allowed_at is not null`,
          [hours, ms],
        );
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/__mock/letters') {
        const { rows } = await db.query('select id, sender_name, content, moderation_status, created_at, reviewed_at, read_at from public.arisa_last_live_letters order by created_at');
        return send(res, 200, rows);
      }
      // 다음 N번의 RPC 를 500 으로 실패시킴 (실패 시 내용 유지 확인용)
      if (req.method === 'POST' && url.pathname === '/__mock/fail') {
        failNext = Number(url.searchParams.get('count') || 1);
        return send(res, 200, { ok: true, failNext });
      }
      // 로그인 실패 기록 비우기 (잠금 확인 뒤 초기화용)
      if (req.method === 'POST' && url.pathname === '/__mock/reset-auth') {
        await db.query('delete from public.arisa_letterbox_auth_attempts');
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { code: 'not_found' });
    } catch (err) {
      return send(res, 400, { code: err.code || 'error', message: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  if (!quiet) console.log(`mock supabase: http://127.0.0.1:${port}`);
  return {
    port,
    db,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMockSupabase({ seed: process.argv.includes('--seed') });
}
