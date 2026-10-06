-- Hi There — для админки: кто онлайн и когда открывали приложение.
-- Запустить один раз: Supabase → SQL Editor → вставить → Run. Повторный запуск ничего не ломает.
-- Если раньше запускали tutor.sql, эти таблицы уже есть — скрипт их не тронет.

create table if not exists public.presence (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  at         timestamptz not null default now(),
  talking    boolean not null default false
);
create table if not exists public.app_events (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null default 'open',
  at         timestamptz not null default now()
);
create index if not exists app_events_at_idx on public.app_events (at desc);
create index if not exists app_events_user_idx on public.app_events (user_id, at desc);

-- каждый пишет только о себе; читать чужое может только функция admin (ключ сервиса)
alter table public.presence   enable row level security;
alter table public.app_events enable row level security;
drop policy if exists "own presence" on public.presence;
create policy "own presence" on public.presence for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own events" on public.app_events;
create policy "own events" on public.app_events for insert with check (auth.uid() = user_id);
