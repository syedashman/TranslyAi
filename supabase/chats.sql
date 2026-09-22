-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once. It creates the chat tables if they don't exist, and UPGRADES them if they already do
-- (adds missing columns and defaults without deleting any data).

-- ---------- chats ----------
create table if not exists public.chats (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null default 'New chat',
  is_pinned    boolean not null default false,
  is_archived  boolean not null default false,
  is_shared    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.chats add column if not exists title        text        not null default 'New chat';
alter table public.chats add column if not exists is_pinned    boolean     not null default false;
alter table public.chats add column if not exists is_archived  boolean     not null default false;
-- Off by default: a chat is only readable by someone other than its owner once its owner explicitly turns this on.
alter table public.chats add column if not exists is_shared    boolean     not null default false;
alter table public.chats add column if not exists created_at   timestamptz not null default now();
alter table public.chats add column if not exists updated_at   timestamptz not null default now();
alter table public.chats alter column id          set default gen_random_uuid();
alter table public.chats alter column user_id     set default auth.uid();
alter table public.chats alter column title       set default 'New chat';
alter table public.chats alter column is_pinned   set default false;
alter table public.chats alter column is_archived set default false;
alter table public.chats alter column is_shared   set default false;
alter table public.chats alter column created_at  set default now();
alter table public.chats alter column updated_at  set default now();

create index if not exists chats_user_order_idx on public.chats (user_id, is_pinned desc, updated_at desc);

-- ---------- messages ----------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.chats (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text,
  created_at  timestamptz not null default now()
);

alter table public.messages add column if not exists user_id    uuid references auth.users (id) on delete cascade default auth.uid();
alter table public.messages add column if not exists audio_name text;
alter table public.messages add column if not exists result     jsonb;
alter table public.messages add column if not exists seq        bigint generated always as identity;
alter table public.messages alter column id         set default gen_random_uuid();
alter table public.messages alter column user_id    set default auth.uid();
alter table public.messages alter column created_at set default now();
alter table public.messages alter column content    drop not null;

-- Give any messages that already exist an owner (taken from their chat).
update public.messages m
   set user_id = c.user_id
  from public.chats c
 where c.id = m.chat_id and m.user_id is null;

create index if not exists messages_chat_order_idx on public.messages (chat_id, created_at, seq);

-- ---------- row-level security: each user only sees their own rows ----------
alter table public.chats    enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Users manage their own chats"    on public.chats;
drop policy if exists "Users read their own messages"   on public.messages;
drop policy if exists "Users add messages to own chats" on public.messages;
drop policy if exists "Users delete their own messages" on public.messages;

create policy "Users manage their own chats"
  on public.chats for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users read their own messages"
  on public.messages for select
  using (auth.uid() = user_id);

create policy "Users add messages to own chats"
  on public.messages for insert
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.chats c where c.id = chat_id and c.user_id = auth.uid())
  );

create policy "Users delete their own messages"
  on public.messages for delete
  using (auth.uid() = user_id);

-- ---------- narrow opt-in exception: a chat's owner can flag it is_shared = true so its share link works for ----------
-- ---------- other signed-in users too. These only ever ADD read access to rows the owner explicitly flagged; ----------
-- ---------- they never touch insert/update/delete, so only the owner can ever change or post into a chat.     ----------
drop policy if exists "Shared chats are readable by anyone signed in"          on public.chats;
drop policy if exists "Shared chat messages are readable by anyone signed in" on public.messages;

create policy "Shared chats are readable by anyone signed in"
  on public.chats for select
  using (is_shared = true);

create policy "Shared chat messages are readable by anyone signed in"
  on public.messages for select
  using (exists (select 1 from public.chats c where c.id = messages.chat_id and c.is_shared = true));

-- ---------- move a chat to the top of "Recents" whenever a message is added ----------
create or replace function public.touch_chat_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chats set updated_at = now() where id = new.chat_id;
  return new;
end;
$$;

drop trigger if exists on_message_created on public.messages;
create trigger on_message_created
  after insert on public.messages
  for each row execute function public.touch_chat_on_message();

-- Make the API notice the new columns straight away.
notify pgrst, 'reload schema';
