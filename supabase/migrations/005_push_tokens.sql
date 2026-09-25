-- Push tokeny pro Expo push notifikace
create table if not exists push_tokens (
  token       text primary key,
  platform    text not null default 'ios',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Bez RLS — gateway má servisní klíč
alter table push_tokens disable row level security;
