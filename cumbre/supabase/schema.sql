-- Cumbre — esquema de base de datos (Postgres / Supabase)
-- Aplícalo desde el SQL Editor de Supabase, o con `supabase db push`.
-- Es idempotente: puedes correrlo de nuevo sin romper nada.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- tipos

do $$ begin
  create type public.item_source as enum ('manual', 'canvas', 'gcal', 'ics');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------- perfil

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  areas       text[]      not null default array['SFU','FINSA','Badminton','Proyectos','Personal'],
  day_start   smallint    not null default 7  check (day_start between 0 and 23),
  day_end     smallint    not null default 23 check (day_end   between 1 and 24),
  timezone    text        not null default 'America/Vancouver',
  created_at  timestamptz not null default now(),
  constraint profiles_day_range_ck check (day_end > day_start)
);

-- ---------------------------------------------------------------- tareas

create table if not exists public.tasks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  title          text not null,
  area           text,
  due_date       date,
  due_time       time,
  est_minutes    int      check (est_minutes is null or est_minutes between 1 and 1440),
  priority       smallint not null default 3 check (priority between 1 and 3),
  done           boolean  not null default false,
  done_at        timestamptz,
  body           text,
  source         public.item_source not null default 'manual',
  external_id    text,
  external_url   text,
  -- Se pone cuando el usuario edita la tarea a mano. El sync respeta estas
  -- filas: sólo refresca título y fecha, nunca done / priority / area.
  user_edited_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Enfoque del día: hasta 3 tareas fijadas para una fecha concreta. Va como
-- columna de `tasks` y no como tabla aparte para no duplicar la RLS.
alter table public.tasks add column if not exists focus_day date;

create index if not exists tasks_focus_idx on public.tasks (user_id, focus_day);

-- Esto es lo que hace que sincronizar dos veces no duplique nada.
-- Índice completo, no parcial: Postgres trata los NULL como distintos entre sí,
-- así que las tareas manuales (external_id null) no chocan. Un índice parcial
-- SÍ funcionaría para eso, pero obliga a repetir el `where` dentro de cada
-- ON CONFLICT y es un error silencioso esperando a pasar.
create unique index if not exists tasks_external_uniq
  on public.tasks (user_id, source, external_id);

create index if not exists tasks_due_idx on public.tasks (user_id, done, due_date);

-- ------------------------------------------------------------- calendario

create table if not exists public.events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  title        text not null,
  -- Evento con hora: starts_at / ends_at. Evento de día completo: all_day_date.
  -- Nunca los dos a la vez.
  starts_at    timestamptz,
  ends_at      timestamptz,
  all_day_date date,
  location     text,
  course_ref   text,
  source       public.item_source not null,
  external_id  text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint events_when_ck check (
    (starts_at is not null and all_day_date is null) or
    (starts_at is null     and all_day_date is not null)
  ),
  constraint events_order_ck check (ends_at is null or ends_at >= starts_at)
);

create unique index if not exists events_external_uniq
  on public.events (user_id, source, external_id);

create index if not exists events_starts_idx on public.events (user_id, starts_at);
create index if not exists events_allday_idx on public.events (user_id, all_day_date);

-- ----------------------------------------------------------------- notas

create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  body       text not null,
  pinned     boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notes_recent_idx on public.notes (user_id, pinned desc, created_at desc);

-- --------------------------------------------------------------- rutinas

create table if not exists public.habits (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  -- Días de la semana en que aplica, 0 = domingo.
  days       smallint[] not null default '{0,1,2,3,4,5,6}'::smallint[],
  archived   boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.habit_log (
  habit_id uuid not null references public.habits (id) on delete cascade,
  user_id  uuid not null references auth.users (id) on delete cascade,
  day      date not null,
  primary key (habit_id, day)
);

create index if not exists habit_log_user_day_idx on public.habit_log (user_id, day desc);

-- ------------------------------------------------------- bloques del día

create table if not exists public.blocks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  day        date not null,
  -- Minutos desde medianoche, hora local del usuario.
  start_min  smallint not null check (start_min between 0 and 1439),
  end_min    smallint not null check (end_min   between 1 and 1440),
  title      text not null,
  kind       text not null default 'tarea' check (kind in ('tarea','descanso','clase')),
  task_id    uuid references public.tasks (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint blocks_order_ck check (end_min > start_min)
);

create index if not exists blocks_day_idx on public.blocks (user_id, day, start_min);

-- ------------------------------------------------------ estado del sync

create table if not exists public.sync_state (
  user_id        uuid not null references auth.users (id) on delete cascade,
  source         public.item_source not null,
  last_synced_at timestamptz,
  last_error     text,
  items_synced   int not null default 0,
  primary key (user_id, source)
);

-- ------------------------------------------------------------- triggers

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

drop trigger if exists events_touch on public.events;
create trigger events_touch before update on public.events
  for each row execute function public.touch_updated_at();

-- Crea el perfil en cuanto alguien se registra.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------ RLS
-- Sin esto, cualquiera con la anon key (que es pública) lee todas tus filas.

alter table public.profiles   enable row level security;
alter table public.tasks      enable row level security;
alter table public.events     enable row level security;
alter table public.notes      enable row level security;
alter table public.habits     enable row level security;
alter table public.habit_log  enable row level security;
alter table public.blocks     enable row level security;
alter table public.sync_state enable row level security;

drop policy if exists own_profile on public.profiles;
create policy own_profile on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists own_tasks on public.tasks;
create policy own_tasks on public.tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_events on public.events;
create policy own_events on public.events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_notes on public.notes;
create policy own_notes on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_habits on public.habits;
create policy own_habits on public.habits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_habit_log on public.habit_log;
create policy own_habit_log on public.habit_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_blocks on public.blocks;
create policy own_blocks on public.blocks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_sync_state on public.sync_state;
create policy own_sync_state on public.sync_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
