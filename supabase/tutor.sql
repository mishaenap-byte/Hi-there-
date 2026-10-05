-- Hi There: ИИ-репетитор. Таблицы, правила доступа (RLS) и хранилище для готовой озвучки.
-- Запустить один раз: SQL Editor → New query → вставить весь файл → Run. Повторный запуск ничего не ломает.
-- Пишет во все таблицы функция tutor (служебный доступ). Человек из приложения может только ЧИТАТЬ свои строки,
-- а presence и app_events — ещё и записывать свои (кто онлайн, входы). Чужие строки база не отдаёт никому.

-- анкета: ответы при регистрации (цель, работа, интересы, страхи, событие, время, голос, строгость, язык объяснений)
create table if not exists public.learner_profile (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
-- план на 4 недели: недели, цель недели, уроки-ситуации и уроки «Основного блока», статус
create table if not exists public.learning_plan (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  plan       jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
-- урок с репетитором
create table if not exists public.tutor_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  situation  text,
  title      text,
  plan_item  text,
  mode       text not null default 'voice',          -- voice | text (после дневной страховки)
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  minutes    numeric not null default 0,
  voice_sec  numeric not null default 0,             -- секунды голоса (человек + репетитор)
  turns      int not null default 0,
  summary    jsonb                                   -- итог: типы ошибок, тема для повторения, текст разбора
);
create index if not exists tutor_sessions_user_idx on public.tutor_sessions (user_id, started_at desc);

-- реплики
create table if not exists public.tutor_turns (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.tutor_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('user', 'tutor')),
  text       text not null,
  sec        numeric,
  at         timestamptz not null default now()
);
create index if not exists tutor_turns_session_idx on public.tutor_turns (session_id, at);

-- ошибки: было / как правильно / тип / объяснение (+ подробный разбор после урока)
create table if not exists public.tutor_mistakes (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.tutor_sessions(id) on delete cascade,
  turn_id    uuid references public.tutor_turns(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  wrong      text not null,
  fix        text not null,
  type       text not null default 'other',
  explain    text,
  detail     jsonb,
  at         timestamptz not null default now()
);
create index if not exists tutor_mistakes_user_idx on public.tutor_mistakes (user_id, at desc);
create index if not exists tutor_mistakes_session_idx on public.tutor_mistakes (session_id);

-- домашка из ошибок урока
create table if not exists public.tutor_homework (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.tutor_sessions(id) on delete set null,
  tasks      jsonb not null default '[]',
  status     text not null default 'new' check (status in ('new', 'done')),
  score      int,
  total      int,
  answers    jsonb,
  sent_to    uuid,                                   -- группа, куда отправили на проверку людям
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
create index if not exists tutor_homework_user_idx on public.tutor_homework (user_id, created_at desc);

-- память о человеке: где остановились, частые ошибки, что рассказал о себе
create table if not exists public.tutor_memory (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  memory     jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- расходы: каждый вызов голоса, распознавания и модели
create table if not exists public.usage_costs (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete set null,
  session_id uuid,
  service    text not null,                          -- tts | stt | llm
  model      text,
  units      numeric not null default 0,
  unit       text,                                   -- sec | tokens
  cost_usd   numeric not null default 0,
  at         timestamptz not null default now()
);
create index if not exists usage_costs_at_idx on public.usage_costs (at desc);
create index if not exists usage_costs_user_idx on public.usage_costs (user_id, at desc);

-- кто онлайн (приложение отмечается раз в ~45 секунд) и входы
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

-- доступ: free (2 пробных урока) | beta | sub (подписка)
create table if not exists public.tutor_access (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  plan       text not null default 'free' check (plan in ('free', 'beta', 'sub')),
  until      timestamptz,
  note       text,
  updated_at timestamptz not null default now()
);

-- ---------- правила доступа ----------
alter table public.learner_profile enable row level security;
alter table public.learning_plan   enable row level security;
alter table public.tutor_sessions  enable row level security;
alter table public.tutor_turns     enable row level security;
alter table public.tutor_mistakes  enable row level security;
alter table public.tutor_homework  enable row level security;
alter table public.tutor_memory    enable row level security;
alter table public.usage_costs     enable row level security;
alter table public.presence        enable row level security;
alter table public.app_events      enable row level security;
alter table public.tutor_access    enable row level security;

do $$
declare t text;
begin
  -- читать только свои строки
  foreach t in array array['learner_profile','learning_plan','tutor_sessions','tutor_turns','tutor_mistakes','tutor_homework','tutor_memory','tutor_access'] loop
    execute format('drop policy if exists "own read" on public.%I', t);
    execute format('create policy "own read" on public.%I for select using (auth.uid() = user_id)', t);
  end loop;
end $$;

drop policy if exists "own presence" on public.presence;
create policy "own presence" on public.presence for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own events" on public.app_events;
create policy "own events" on public.app_events for insert with check (auth.uid() = user_id);
-- usage_costs: правил нет — из приложения таблицу не видно, пишет и читает только функция

-- ---------- хранилище: стандартные фразы озвучиваются один раз ----------
insert into storage.buckets (id, name, public) values ('tutor-tts', 'tutor-tts', true)
on conflict (id) do nothing;
