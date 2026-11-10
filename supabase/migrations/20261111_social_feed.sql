begin;
create table if not exists public.music_posts (
 id uuid primary key default gen_random_uuid(),
 track_id uuid not null unique references public.music_tracks(id) on delete cascade,
 telegram_user_id bigint not null,
 author_label text not null check(length(author_label) between 1 and 60),
 caption text not null default '' check(length(caption)<=280),
 rights_confirmed boolean not null check(rights_confirmed),
 status text not null default 'published' check(status in ('published','withdrawn','hidden')),
 created_at timestamptz not null default now(),
 foreign key(telegram_user_id,track_id) references public.music_tracks(telegram_user_id,id) on delete cascade
);
create table if not exists public.music_post_likes (
 post_id uuid not null references public.music_posts(id) on delete cascade,
 telegram_user_id bigint not null,
 created_at timestamptz not null default now(), primary key(post_id,telegram_user_id)
);
create table if not exists public.music_post_comments (
 id uuid primary key default gen_random_uuid(),
 post_id uuid not null references public.music_posts(id) on delete cascade,
 telegram_user_id bigint not null,
 author_label text not null check(length(author_label) between 1 and 60),
 body text not null check(length(trim(body)) between 1 and 500),
 deleted boolean not null default false,
 created_at timestamptz not null default now()
);
create index if not exists music_post_comments_time on public.music_post_comments(post_id,created_at desc);
create table if not exists public.music_post_reposts (
 post_id uuid not null references public.music_posts(id) on delete cascade,
 telegram_user_id bigint not null,
 author_label text not null check(length(author_label) between 1 and 60),
 created_at timestamptz not null default now(), primary key(post_id,telegram_user_id)
);
create table if not exists public.music_post_reports (
 post_id uuid not null references public.music_posts(id) on delete cascade,
 telegram_user_id bigint not null,
 reason text not null check(length(trim(reason)) between 1 and 500),
 created_at timestamptz not null default now(), primary key(post_id,telegram_user_id)
);
alter table public.music_posts enable row level security;
alter table public.music_post_likes enable row level security;
alter table public.music_post_comments enable row level security;
alter table public.music_post_reposts enable row level security;
alter table public.music_post_reports enable row level security;
revoke all on public.music_posts,public.music_post_likes,public.music_post_comments,public.music_post_reposts,public.music_post_reports from anon,authenticated;
grant all on public.music_posts,public.music_post_likes,public.music_post_comments,public.music_post_reposts,public.music_post_reports to service_role;
create or replace function public.melo_social_feed(viewer bigint, page_offset integer default 0, selected_post uuid default null)
returns jsonb language sql stable security invoker set search_path=public as $$
 select coalesce(jsonb_agg(to_jsonb(item) order by item.activity_at desc,item.id), '[]'::jsonb)
 from (
  select p.id,p.track_id,p.author_label,p.caption,p.created_at,
   t.title,t.artist,t.duration_seconds,
   p.telegram_user_id=viewer as mine,
   exists(select 1 from music_post_likes l where l.post_id=p.id and l.telegram_user_id=viewer) as liked,
   exists(select 1 from music_post_reposts r where r.post_id=p.id and r.telegram_user_id=viewer) as reposted,
   (select count(*) from music_post_likes l where l.post_id=p.id) as likes,
   (select count(*) from music_post_comments c where c.post_id=p.id and not c.deleted) as comments,
   (select count(*) from music_post_reposts r where r.post_id=p.id) as reposts,
   (select r.author_label from music_post_reposts r where r.post_id=p.id order by r.created_at desc limit 1) as shared_by,
   greatest(p.created_at,coalesce((select max(r.created_at) from music_post_reposts r where r.post_id=p.id),p.created_at)) as activity_at
  from music_posts p join music_tracks t on t.id=p.track_id
  where p.status='published' and (selected_post is null or p.id=selected_post)
  order by activity_at desc,p.id limit 20 offset greatest(0,least(page_offset,10000))
 ) item
$$;
revoke all on function public.melo_social_feed(bigint,integer,uuid) from public,anon,authenticated;
grant execute on function public.melo_social_feed(bigint,integer,uuid) to service_role;
commit;
