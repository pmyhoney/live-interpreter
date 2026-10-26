-- 통역 세션과 문장 단위 기록. 각 사용자는 자기 행만 접근.
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text,
  src text not null,
  tgt text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.segments (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  start_ms integer not null,
  end_ms integer not null,
  sl text not null,
  tl text not null,
  orig text not null,
  trans text not null default '',
  created_at timestamptz not null default now()
);

create index segments_session_idx on public.segments (session_id, start_ms);
create index sessions_user_idx on public.sessions (user_id, started_at desc);

alter table public.sessions enable row level security;
alter table public.segments enable row level security;

create policy "own sessions" on public.sessions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "own segments" on public.segments
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid()))
  );
