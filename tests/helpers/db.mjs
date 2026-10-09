import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export const MIGRATION_URL = new URL('../../supabase/migrations/20261009000000_create_arisa_last_live_letters.sql', import.meta.url);

// Supabase 의 기본 역할과 기본 권한(anon/authenticated 에 자동 부여)을 흉내 낸 뒤 마이그레이션을 적용
export async function createTestDb(options = {}) {
  const db = new PGlite(options.dataDir);
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  await db.exec(readFileSync(MIGRATION_URL, 'utf8'));
  return db;
}

export async function asRole(db, role, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    return tx.query(sql, params);
  });
}

// PostgREST 의 /rest/v1/rpc/<name> 호출(이름 있는 인자)을 service_role 로 흉내 냄
export function makeRpc(db) {
  return async function rpc(name, args = {}) {
    if (!/^arisa_[a-z_]+$/.test(name)) throw new Error(`unknown rpc ${name}`);
    const keys = Object.keys(args);
    if (!keys.every((k) => /^p_[a-z_]+$/.test(k))) throw new Error('bad rpc argument name');
    const call = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const res = await asRole(db, 'service_role', `select public.${name}(${call}) as result`, keys.map((k) => args[k]));
    return res.rows[0].result;
  };
}

/** 테스트용 편지를 바로 넣고(approved 등으로 바꿈) id 를 돌려줌 */
export async function seedLetter(db, { name = null, content = '안녕하세요', status = 'approved', createdAt = null, read = false } = {}) {
  const ins = await db.query(
    'insert into public.arisa_last_live_letters (sender_name, content) values ($1, $2) returning id',
    [name, content],
  );
  const id = ins.rows[0].id;
  await db.query(
    `update public.arisa_last_live_letters
        set moderation_status = $2,
            reviewed_at = case when $2 = 'pending' then null else now() end,
            created_at = coalesce($3::timestamptz, created_at),
            read_at = case when $4::boolean then now() else null end
      where id = $1`,
    [id, status, createdAt, read],
  );
  return id;
}
