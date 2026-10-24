-- R29-Track community levels (used by editor.html and the game's "Community levels" list).
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Anyone with the publishable key can read, create and update levels (no deletes), like the leaderboard.
create table if not exists public.levels (
  id text primary key check (id ~ '^[a-z0-9]{6,16}$'),
  name text not null check (char_length(name) between 1 and 40),
  author text not null default '' check (char_length(author) <= 16),
  mode text not null default 'race' check (mode in ('race', 'arena')),
  data jsonb not null check (octet_length(data::text) < 300000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists levels_updated_idx on public.levels (updated_at desc);
alter table public.levels enable row level security;
drop policy if exists "levels public read" on public.levels;
create policy "levels public read" on public.levels for select to anon, authenticated using (true);
drop policy if exists "levels public insert" on public.levels;
create policy "levels public insert" on public.levels for insert to anon, authenticated with check (true);
drop policy if exists "levels public update" on public.levels;
create policy "levels public update" on public.levels for update to anon, authenticated using (true) with check (true);
grant select, insert, update on public.levels to anon, authenticated;
