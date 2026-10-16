-- R29-Track online leaderboard. Public read + insert with the publishable key; no updates or deletes.
create table if not exists public.lap_times (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  player_name text not null check (char_length(player_name) between 1 and 16),
  map_id text not null check (char_length(map_id) between 1 and 32),
  car_id text not null check (char_length(car_id) between 1 and 32),
  weather text not null default 'clear' check (char_length(weather) <= 16),
  time_ms integer not null check (time_ms between 5000 and 7200000)
);
create index if not exists lap_times_map_time_idx on public.lap_times (map_id, time_ms);
alter table public.lap_times enable row level security;
drop policy if exists "lap_times public read" on public.lap_times;
create policy "lap_times public read" on public.lap_times for select to anon, authenticated using (true);
drop policy if exists "lap_times public insert" on public.lap_times;
create policy "lap_times public insert" on public.lap_times for insert to anon, authenticated with check (true);
grant select, insert on public.lap_times to anon, authenticated;
