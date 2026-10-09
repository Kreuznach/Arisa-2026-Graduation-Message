-- ─────────────────────────────────────────────────────────────────────────
-- ARISA · LAST LIVE 팬 편지 (기존 mokano.live 와 같은 Supabase 프로젝트)
--
-- 이 파일은 "arisa_" 로 시작하는 새 객체만 만듭니다.
-- 모카 쪽 테이블·함수·정책·Auth 사용자는 읽지도, 바꾸지도 않습니다.
--
-- 적용: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여 넣고 Run
--       (또는 supabase CLI: supabase db push)
-- 여러 번 실행해도 안전하도록 if not exists / or replace 를 사용합니다.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) 편지 본문 테이블 ------------------------------------------------------
create table if not exists public.arisa_last_live_letters (
  id uuid primary key default gen_random_uuid(),
  sender_name text,
  content text not null,
  moderation_status text not null default 'pending',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  read_at timestamptz,
  constraint arisa_last_live_letters_sender_name_check check (
    sender_name is null
    or (char_length(sender_name) between 1 and 40 and sender_name = btrim(sender_name))
  ),
  -- 최대 2,000줄(개행 1,999개) + UTF-8 256KiB, CR 없음(LF 로 정규화), 공백뿐인 내용 금지
  constraint arisa_last_live_letters_content_check check (
    btrim(content, E' \t\n') <> ''
    and position(E'\r' in content) = 0
    and octet_length(content) <= 262144
    and char_length(content) - char_length(replace(content, E'\n', '')) < 2000
  ),
  constraint arisa_last_live_letters_moderation_status_check check (
    moderation_status in ('pending', 'approved', 'hidden')
  )
);

comment on table public.arisa_last_live_letters is
  '팬이 아리사에게 보낸 마지막 라이브 편지. 저장은 서버 API(arisa_submit_letter)로만 합니다.';
comment on column public.arisa_last_live_letters.sender_name is 'null 이면 익명으로 표시';
comment on column public.arisa_last_live_letters.content is 'plain text 원문 (HTML/Markdown 으로 렌더링하지 않음)';
comment on column public.arisa_last_live_letters.reviewed_at is '관리자가 승인/숨김을 처리한 시각 (대기 상태면 null)';
comment on column public.arisa_last_live_letters.read_at is '아리사가 원문을 처음 연 시각 (최초 1회, DB 시각)';

create index if not exists arisa_last_live_letters_status_created_idx
  on public.arisa_last_live_letters (moderation_status, created_at desc);

-- 새 편지는 누가 넣더라도 항상 pending / DB 시각 / 미검수 / 미열람으로 시작
create or replace function public.arisa_letters_enforce_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.moderation_status := 'pending';
  new.created_at := now();
  new.reviewed_at := null;
  new.read_at := null;
  return new;
end;
$$;

revoke all on function public.arisa_letters_enforce_insert() from public, anon, authenticated;

drop trigger if exists arisa_letters_enforce_insert on public.arisa_last_live_letters;
create trigger arisa_letters_enforce_insert
  before insert on public.arisa_last_live_letters
  for each row execute function public.arisa_letters_enforce_insert();

-- 2) 제출 제한 테이블 (서버 전용, 편지 테이블과 분리) ---------------------
create table if not exists public.arisa_letter_submission_limits (
  browser_hash text primary key,
  last_success_at timestamptz,
  next_allowed_at timestamptz,
  last_idempotency_key uuid,
  last_letter_id uuid references public.arisa_last_live_letters (id) on delete set null,
  success_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint arisa_letter_submission_limits_hash_check check (browser_hash ~ '^[0-9a-f]{64}$'),
  constraint arisa_letter_submission_limits_times_check check ((last_success_at is null) = (next_allowed_at is null)),
  constraint arisa_letter_submission_limits_count_check check (success_count >= 0)
);

comment on table public.arisa_letter_submission_limits is
  '브라우저 식별자 해시별 48시간 제출 제한과 중복 요청 처리 정보. 아리사 전용이며 편지 삭제·검수와 무관하게 유지됩니다.';

-- 3) 로그인 실패 제한 테이블 (아리사 접근 코드 / 관리자 로그인 공용, 서버 전용) --
create table if not exists public.arisa_letterbox_auth_attempts (
  key_hash text primary key,
  window_started_at timestamptz not null default now(),
  fail_count integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint arisa_letterbox_auth_attempts_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint arisa_letterbox_auth_attempts_count_check check (fail_count >= 0)
);

comment on table public.arisa_letterbox_auth_attempts is
  '아리사 편지함 코드·관리자 로그인 실패 횟수(서버가 만든 해시 키별). 원본 IP/이메일은 저장하지 않습니다.';

-- 4) 접근 권한: anon / authenticated 는 세 테이블에 직접 접근 불가 --------
alter table public.arisa_last_live_letters enable row level security;
alter table public.arisa_letter_submission_limits enable row level security;
alter table public.arisa_letterbox_auth_attempts enable row level security;

revoke all on table public.arisa_last_live_letters from public, anon, authenticated;
revoke all on table public.arisa_letter_submission_limits from public, anon, authenticated;
revoke all on table public.arisa_letterbox_auth_attempts from public, anon, authenticated;
grant select, insert, update on table public.arisa_last_live_letters to service_role;
grant select, insert, update on table public.arisa_letter_submission_limits to service_role;
grant select, insert, update, delete on table public.arisa_letterbox_auth_attempts to service_role;

-- 5) 편지 저장 RPC: 제한 확인 + 저장 + 제한 갱신을 한 트랜잭션에서 처리 -------
create or replace function public.arisa_submit_letter(
  p_browser_hash text,
  p_idempotency_key uuid,
  p_sender_name text,
  p_content text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_limit public.arisa_letter_submission_limits%rowtype;
  v_letter_id uuid;
  v_created_at timestamptz;
  v_next timestamptz;
begin
  if p_browser_hash is null or p_browser_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid browser hash' using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'missing idempotency key' using errcode = '22023';
  end if;

  -- 최초 동시 요청: 고유 키 충돌로 한 행만 생기고, 아래 FOR UPDATE 에서 순서대로 처리됨
  insert into public.arisa_letter_submission_limits (browser_hash)
  values (p_browser_hash)
  on conflict (browser_hash) do nothing;

  select * into v_limit
  from public.arisa_letter_submission_limits
  where browser_hash = p_browser_hash
  for update;

  -- 같은 요청의 재시도(응답 유실 등): 새로 저장하지 않고 기존 성공을 돌려줌
  if v_limit.last_idempotency_key = p_idempotency_key then
    return jsonb_build_object(
      'status', 'replayed',
      'next_allowed_at_ms', ceil(extract(epoch from v_limit.next_allowed_at) * 1000)::bigint,
      'server_now_ms', floor(extract(epoch from v_now) * 1000)::bigint
    );
  end if;

  if v_limit.next_allowed_at is not null and v_limit.next_allowed_at > v_now then
    return jsonb_build_object(
      'status', 'limited',
      'next_allowed_at_ms', ceil(extract(epoch from v_limit.next_allowed_at) * 1000)::bigint,
      'server_now_ms', floor(extract(epoch from v_now) * 1000)::bigint
    );
  end if;

  insert into public.arisa_last_live_letters (sender_name, content)
  values (nullif(p_sender_name, ''), p_content)
  returning id, created_at into v_letter_id, v_created_at;

  v_next := v_created_at + interval '48 hours';

  update public.arisa_letter_submission_limits
  set last_success_at = v_created_at,
      next_allowed_at = v_next,
      last_idempotency_key = p_idempotency_key,
      last_letter_id = v_letter_id,
      success_count = success_count + 1,
      updated_at = v_now
  where browser_hash = p_browser_hash;

  return jsonb_build_object(
    'status', 'created',
    'next_allowed_at_ms', ceil(extract(epoch from v_next) * 1000)::bigint,
    'server_now_ms', floor(extract(epoch from v_now) * 1000)::bigint
  );
end;
$$;

-- 6) 작성 가능 상태 조회 RPC -----------------------------------------------
create or replace function public.arisa_get_submit_status(p_browser_hash text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'next_allowed_at_ms', (
      select ceil(extract(epoch from l.next_allowed_at) * 1000)::bigint
      from public.arisa_letter_submission_limits l
      where l.browser_hash = p_browser_hash
        and l.next_allowed_at > now()
    ),
    'server_now_ms', floor(extract(epoch from now()) * 1000)::bigint
  );
$$;

-- 7) 로그인 실패 제한 함수 --------------------------------------------------
-- 잠금 중이면 남은 초, 아니면 0
create or replace function public.arisa_auth_lock_seconds(p_key text, p_window_seconds integer, p_max integer)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select greatest(0, ceil(extract(epoch from (window_started_at + make_interval(secs => p_window_seconds) - now()))))::integer
       from public.arisa_letterbox_auth_attempts
      where key_hash = p_key
        and fail_count >= p_max
        and window_started_at + make_interval(secs => p_window_seconds) > now()),
    0);
$$;

-- 실패 1회 기록(원자적). 기록 후 잠금 상태면 남은 초, 아니면 0
create or replace function public.arisa_auth_register_failure(p_key text, p_window_seconds integer, p_max integer)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.arisa_letterbox_auth_attempts as a (key_hash, window_started_at, fail_count)
  values (p_key, now(), 1)
  on conflict (key_hash) do update
    set window_started_at = case
          when a.window_started_at + make_interval(secs => p_window_seconds) <= now() then now()
          else a.window_started_at end,
        fail_count = case
          when a.window_started_at + make_interval(secs => p_window_seconds) <= now() then 1
          else a.fail_count + 1 end,
        updated_at = now();
  return public.arisa_auth_lock_seconds(p_key, p_window_seconds, p_max);
end;
$$;

create or replace function public.arisa_auth_clear_failures(p_key text)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.arisa_letterbox_auth_attempts where key_hash = p_key;
$$;

-- 8) 아리사 편지함: 승인된 편지만 목록·상세 ----------------------------------
-- 목록: counts 는 승인된 편지 전체 기준, items 는 필터·정렬·페이지 적용. 원문(content)은 담지 않음
create or replace function public.arisa_list_letters(
  p_filter text,
  p_sort text,
  p_page integer,
  p_page_size integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_filter text := case when p_filter in ('unread', 'read') then p_filter else 'all' end;
  v_dir text := case when p_sort = 'asc' then 'asc' else 'desc' end;
  v_size integer := least(50, greatest(1, coalesce(p_page_size, 12)));
  v_total bigint;
  v_unread bigint;
  v_filtered bigint;
  v_pages integer;
  v_page integer;
  v_items jsonb;
begin
  select count(*), count(*) filter (where read_at is null)
    into v_total, v_unread
    from public.arisa_last_live_letters
   where moderation_status = 'approved';

  v_filtered := case v_filter when 'unread' then v_unread when 'read' then v_total - v_unread else v_total end;
  v_pages := greatest(1, ceil(v_filtered::numeric / v_size)::integer);
  v_page := least(greatest(1, coalesce(p_page, 1)), v_pages);

  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id,
             'sender_name', s.sender_name,
             'created_at', s.created_at,
             'is_read', s.read_at is not null
           ) order by s.n), '[]'::jsonb)
      from (
        select l.id, l.sender_name, l.created_at, l.read_at,
               row_number() over (order by l.created_at %1$s, l.id %1$s) as n
          from public.arisa_last_live_letters l
         where l.moderation_status = 'approved'
           and ($1 = 'all' or ($1 = 'unread' and l.read_at is null) or ($1 = 'read' and l.read_at is not null))
         order by l.created_at %1$s, l.id %1$s
         limit $2 offset $3
      ) s
  $q$, v_dir)
  into v_items
  using v_filter, v_size, (v_page - 1) * v_size;

  return jsonb_build_object(
    'counts', jsonb_build_object('total', v_total, 'unread', v_unread, 'read', v_total - v_unread),
    'page', v_page,
    'page_size', v_size,
    'total_pages', v_pages,
    'items', v_items
  );
end;
$$;

-- 상세: 승인된 편지만. 없거나 승인되지 않았으면 null (둘을 구분하지 않음)
-- prev/next 는 같은 정렬 순서에서 필터 조건에 맞는 바로 앞/뒤 편지
create or replace function public.arisa_get_letter(p_id uuid, p_filter text, p_sort text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_filter text := case when p_filter in ('unread', 'read') then p_filter else 'all' end;
  v_dir text := case when p_sort = 'asc' then 'asc' else 'desc' end;
  v_letter public.arisa_last_live_letters%rowtype;
  v_prev uuid;
  v_next uuid;
begin
  select * into v_letter
    from public.arisa_last_live_letters
   where id = p_id and moderation_status = 'approved';
  if not found then
    return null;
  end if;

  execute format($q$
    with ordered as (
      select l.id, l.read_at,
             row_number() over (order by l.created_at %1$s, l.id %1$s) as n
        from public.arisa_last_live_letters l
       where l.moderation_status = 'approved'
    ), me as (
      select n from ordered where id = $1
    ), hits as (
      select o.id, o.n from ordered o
       where $2 = 'all' or ($2 = 'unread' and o.read_at is null) or ($2 = 'read' and o.read_at is not null)
    )
    select
      (select h.id from hits h, me where h.n < me.n order by h.n desc limit 1),
      (select h.id from hits h, me where h.n > me.n order by h.n asc limit 1)
  $q$, v_dir)
  into v_prev, v_next
  using p_id, v_filter;

  return jsonb_build_object(
    'id', v_letter.id,
    'sender_name', v_letter.sender_name,
    'content', v_letter.content,
    'created_at', v_letter.created_at,
    'read_at', v_letter.read_at,
    'prev_id', v_prev,
    'next_id', v_next
  );
end;
$$;

-- 최초 개봉 기록: approved 이고 read_at 이 비어 있을 때만 DB 시각을 저장.
-- 이미 읽은 편지는 기존 시각을 그대로 돌려주고, 승인되지 않았거나 없으면 null
create or replace function public.arisa_mark_letter_read(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_read_at timestamptz;
begin
  update public.arisa_last_live_letters
     set read_at = now()
   where id = p_id
     and moderation_status = 'approved'
     and read_at is null
  returning read_at into v_read_at;

  if v_read_at is null then
    select read_at into v_read_at
      from public.arisa_last_live_letters
     where id = p_id and moderation_status = 'approved';
  end if;

  if v_read_at is null then
    return null;
  end if;
  return jsonb_build_object('read_at', v_read_at);
end;
$$;

-- 9) 관리자: 목록·상세·상태 변경 (서버가 관리자 UID 를 확인한 뒤에만 호출) ------
-- 이 함수들은 read_at 을 절대 바꾸지 않습니다. (관리자 미리보기는 읽음으로 기록되지 않음)
create or replace function public.arisa_admin_list_letters(
  p_status text,
  p_search text,
  p_page integer,
  p_page_size integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_status text := case when p_status in ('pending', 'approved', 'hidden') then p_status else 'all' end;
  v_size integer := least(100, greatest(1, coalesce(p_page_size, 20)));
  v_search text := btrim(coalesce(p_search, ''));
  v_pattern text;
  v_counts jsonb;
  v_filtered bigint;
  v_pages integer;
  v_page integer;
  v_items jsonb;
begin
  select jsonb_build_object(
           'total', count(*),
           'pending', count(*) filter (where moderation_status = 'pending'),
           'approved', count(*) filter (where moderation_status = 'approved'),
           'hidden', count(*) filter (where moderation_status = 'hidden'),
           'read', count(*) filter (where read_at is not null),
           'unread_approved', count(*) filter (where moderation_status = 'approved' and read_at is null)
         )
    into v_counts
    from public.arisa_last_live_letters;

  v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select count(*) into v_filtered
    from public.arisa_last_live_letters l
   where (v_status = 'all' or l.moderation_status = v_status)
     and (v_search = '' or l.sender_name ilike v_pattern or l.content ilike v_pattern);

  v_pages := greatest(1, ceil(v_filtered::numeric / v_size)::integer);
  v_page := least(greatest(1, coalesce(p_page, 1)), v_pages);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'sender_name', s.sender_name,
           'preview', s.preview,
           'moderation_status', s.moderation_status,
           'created_at', s.created_at,
           'reviewed_at', s.reviewed_at,
           'is_read', s.read_at is not null
         ) order by s.n), '[]'::jsonb)
    into v_items
    from (
      select l.id, l.sender_name, left(l.content, 200) as preview, l.moderation_status,
             l.created_at, l.reviewed_at, l.read_at,
             row_number() over (order by l.created_at desc, l.id desc) as n
        from public.arisa_last_live_letters l
       where (v_status = 'all' or l.moderation_status = v_status)
         and (v_search = '' or l.sender_name ilike v_pattern or l.content ilike v_pattern)
       order by l.created_at desc, l.id desc
       limit v_size offset (v_page - 1) * v_size
    ) s;

  return jsonb_build_object(
    'counts', v_counts,
    'page', v_page,
    'page_size', v_size,
    'total_pages', v_pages,
    'items', v_items
  );
end;
$$;

-- 미리보기용 상세: 상태와 상관없이 한 통. 읽음 기록은 하지 않음
create or replace function public.arisa_admin_get_letter(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', l.id,
    'sender_name', l.sender_name,
    'content', l.content,
    'moderation_status', l.moderation_status,
    'created_at', l.created_at,
    'reviewed_at', l.reviewed_at,
    'read_at', l.read_at
  )
  from public.arisa_last_live_letters l
  where l.id = p_id;
$$;

-- 상태 변경: pending(대기·승인 취소) / approved(승인) / hidden(숨김). 편지가 없으면 null
create or replace function public.arisa_admin_set_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.arisa_last_live_letters%rowtype;
begin
  if p_status is null or p_status not in ('pending', 'approved', 'hidden') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  update public.arisa_last_live_letters
     set moderation_status = p_status,
         reviewed_at = case when p_status = 'pending' then null else now() end
   where id = p_id
  returning * into v_row;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'moderation_status', v_row.moderation_status,
    'reviewed_at', v_row.reviewed_at
  );
end;
$$;

-- 10) 실행 권한: service_role(서버)만 -----------------------------------------
revoke all on function public.arisa_submit_letter(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.arisa_get_submit_status(text) from public, anon, authenticated;
revoke all on function public.arisa_auth_lock_seconds(text, integer, integer) from public, anon, authenticated;
revoke all on function public.arisa_auth_register_failure(text, integer, integer) from public, anon, authenticated;
revoke all on function public.arisa_auth_clear_failures(text) from public, anon, authenticated;
revoke all on function public.arisa_list_letters(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.arisa_get_letter(uuid, text, text) from public, anon, authenticated;
revoke all on function public.arisa_mark_letter_read(uuid) from public, anon, authenticated;
revoke all on function public.arisa_admin_list_letters(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.arisa_admin_get_letter(uuid) from public, anon, authenticated;
revoke all on function public.arisa_admin_set_status(uuid, text) from public, anon, authenticated;

grant execute on function public.arisa_submit_letter(text, uuid, text, text) to service_role;
grant execute on function public.arisa_get_submit_status(text) to service_role;
grant execute on function public.arisa_auth_lock_seconds(text, integer, integer) to service_role;
grant execute on function public.arisa_auth_register_failure(text, integer, integer) to service_role;
grant execute on function public.arisa_auth_clear_failures(text) to service_role;
grant execute on function public.arisa_list_letters(text, text, integer, integer) to service_role;
grant execute on function public.arisa_get_letter(uuid, text, text) to service_role;
grant execute on function public.arisa_mark_letter_read(uuid) to service_role;
grant execute on function public.arisa_admin_list_letters(text, text, integer, integer) to service_role;
grant execute on function public.arisa_admin_get_letter(uuid) to service_role;
grant execute on function public.arisa_admin_set_status(uuid, text) to service_role;
