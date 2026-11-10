begin;
alter table public.music_tracks add column if not exists favorite boolean not null default false;
create unique index if not exists music_tracks_owner_id_key on public.music_tracks(telegram_user_id,id);
create table if not exists public.music_playlists (
 id uuid primary key default gen_random_uuid(),
 telegram_user_id bigint not null,
 client_key text not null,
 name text not null check (length(trim(name)) between 1 and 60),
 created_at timestamptz not null default now(),
 unique(telegram_user_id,id),
 unique(telegram_user_id,client_key)
);
create table if not exists public.music_playlist_tracks (
 telegram_user_id bigint not null,
 playlist_id uuid not null,
 track_id uuid not null,
 primary key(telegram_user_id,playlist_id,track_id),
 foreign key(telegram_user_id,playlist_id) references public.music_playlists(telegram_user_id,id) on delete cascade,
 foreign key(telegram_user_id,track_id) references public.music_tracks(telegram_user_id,id) on delete cascade
);
alter table public.music_playlists enable row level security;
alter table public.music_playlist_tracks enable row level security;
revoke all on public.music_playlists,public.music_playlist_tracks from anon,authenticated;
grant all on public.music_playlists,public.music_playlist_tracks to service_role;
commit;
