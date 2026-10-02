-- Hi There: таблица подписок на пуш-уведомления.
-- Пишет и читает её только функция push-send (через служебный доступ), поэтому правил для пользователей нет:
-- из приложения напрямую таблицу не видно.
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  sub        jsonb not null,
  tz         text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subs (user_id);
alter table public.push_subs enable row level security;
