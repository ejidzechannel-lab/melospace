begin;
create table if not exists public.english_progress (
 telegram_user_id bigint primary key,
 progress jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
create table if not exists public.english_orders (
 id uuid primary key default gen_random_uuid(),telegram_user_id bigint not null,
 pack_id text not null check(pack_id='travel'),amount integer not null check(amount=199),
 status text not null default 'pending' check(status in('pending','paid','refunded')),
 charge_id text unique,created_at timestamptz not null default now(),paid_at timestamptz
);
create table if not exists public.english_unlocks (
 telegram_user_id bigint not null,pack_id text not null,
 order_id uuid not null references public.english_orders(id),
 created_at timestamptz not null default now(),primary key(telegram_user_id,pack_id)
);
alter table public.english_progress enable row level security;
alter table public.english_orders enable row level security;
alter table public.english_unlocks enable row level security;
revoke all on public.english_progress,public.english_orders,public.english_unlocks from anon,authenticated;
grant all on public.english_progress,public.english_orders,public.english_unlocks to service_role;
create or replace function public.melo_english_fulfill(order_uuid uuid,buyer bigint,charge text,stars integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare purchase english_orders%rowtype;
begin
 select * into purchase from english_orders where id=order_uuid for update;
 if not found or purchase.telegram_user_id<>buyer or purchase.amount<>stars or stars<>199 then raise exception 'INVALID_PAYMENT';end if;
 if purchase.status='paid' then return purchase.charge_id=charge;end if;
 if purchase.status<>'pending' then raise exception 'INVALID_PAYMENT_STATE';end if;
 update english_orders set status='paid',charge_id=charge,paid_at=now() where id=order_uuid;
 insert into english_unlocks(telegram_user_id,pack_id,order_id)values(buyer,purchase.pack_id,order_uuid)on conflict(telegram_user_id,pack_id)do nothing;
 return true;
end;$$;
create or replace function public.melo_english_refund(charge text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare purchase english_orders%rowtype;
begin
 select * into purchase from english_orders where charge_id=charge for update;
 if not found then return false;end if;
 delete from english_unlocks where order_id=purchase.id;
 update english_orders set status='refunded' where id=purchase.id;
 return true;
end;$$;
revoke all on function public.melo_english_fulfill(uuid,bigint,text,integer) from public,anon,authenticated;
revoke all on function public.melo_english_refund(text) from public,anon,authenticated;
grant execute on function public.melo_english_fulfill(uuid,bigint,text,integer) to service_role;
grant execute on function public.melo_english_refund(text) to service_role;
create or replace function public.melo_english_sync(buyer bigint,incoming jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare old jsonb;result jsonb;combined jsonb;k text;v jsonb;base integer;
begin
 insert into english_progress(telegram_user_id,progress)values(buyer,'{}')on conflict do nothing;
 select progress into old from english_progress where telegram_user_id=buyer for update;
 result:=case when coalesce((incoming->>'updatedAt')::bigint,0)>=coalesce((old->>'updatedAt')::bigint,0) then incoming else old end;
 combined:=coalesce(old->'completed','{}');
 for k,v in select * from jsonb_each(coalesce(incoming->'completed','{}')) loop
  if not (combined ? k) or coalesce((v->>'accuracy')::integer,0)>coalesce((combined->k->>'accuracy')::integer,0) then combined:=jsonb_set(combined,array[k],v);end if;
 end loop;
 result:=jsonb_set(result,'{completed}',combined);
 combined:=coalesce(old->'daily','{}');
 for k,v in select * from jsonb_each(coalesce(incoming->'daily','{}')) loop
  combined:=jsonb_set(combined,array[k],to_jsonb(greatest(coalesce((v#>>'{}')::integer,0),coalesce((combined->>k)::integer,0))));
 end loop;
 for k,base in select entry.value->>'date',count(*)::integer*20 from jsonb_each(result->'completed') entry where coalesce(entry.value->>'date','')<>'' group by entry.value->>'date' loop
  combined:=jsonb_set(combined,array[k],to_jsonb(greatest(base,coalesce((combined->>k)::integer,0))));
 end loop;
 result:=jsonb_set(result,'{daily}',combined);
 combined:=coalesce(old->'attempts','{}');
 for k,v in select * from jsonb_each(coalesce(incoming->'attempts','{}')) loop
  combined:=jsonb_set(combined,array[k],to_jsonb(greatest(coalesce((v#>>'{}')::integer,0),coalesce((combined->>k)::integer,0))));
 end loop;
 result:=jsonb_set(result,'{attempts}',combined);
 select coalesce(jsonb_agg(distinct value),'[]') into combined from jsonb_array_elements(coalesce(old->'seen','[]')||coalesce(incoming->'seen','[]'));
 result:=jsonb_set(result,'{seen}',combined);
 select coalesce(jsonb_agg(distinct value),'[]') into combined from jsonb_array_elements(coalesce(old->'dates','[]')||coalesce(incoming->'dates','[]'));
 result:=jsonb_set(result,'{dates}',combined);
 update english_progress set progress=result,updated_at=now() where telegram_user_id=buyer;
 return result;
end;$$;
revoke all on function public.melo_english_sync(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.melo_english_sync(bigint,jsonb) to service_role;

commit;
