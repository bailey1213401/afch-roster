-- 응급실 근무표 홈페이지용 저장소 (Supabase > SQL Editor에 통째로 붙여넣고 Run)
-- 로그인한 사람만 읽고 쓸 수 있습니다. 로그인 계정은 Authentication > Users에서 직접 만듭니다.

create table if not exists roster_kv (
  key        text primary key,          -- 'config', 'roster:RN', 'roster:AN', 'wishes' 등
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists roster_log (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  by     text,
  key    text,
  note   text
);

alter table roster_kv  enable row level security;
alter table roster_log enable row level security;

drop policy if exists kv_read   on roster_kv;
drop policy if exists kv_insert on roster_kv;
drop policy if exists kv_update on roster_kv;
drop policy if exists log_read  on roster_log;
drop policy if exists log_write on roster_log;

create policy kv_read   on roster_kv  for select to authenticated using (true);
create policy kv_insert on roster_kv  for insert to authenticated with check (true);
create policy kv_update on roster_kv  for update to authenticated using (true) with check (true);
create policy log_read  on roster_log for select to authenticated using (true);
create policy log_write on roster_log for insert to authenticated with check (true);

-- 새 프로젝트는 표 권한을 자동으로 주지 않으므로 로그인한 사용자에게만 줌 (비로그인 anon은 권한 없음)
grant usage on schema public to authenticated;
grant select, insert, update on public.roster_kv to authenticated;
grant select, insert on public.roster_log to authenticated;
grant usage, select on sequence public.roster_log_id_seq to authenticated;
