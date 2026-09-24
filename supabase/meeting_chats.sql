-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run. Safe to run more than once.
--
-- Introduces the Meeting Chat / Meeting Result parent-child relationship the app now needs:
--   meeting_chats  (NEW - parent, one row per "Meeting Chat" conversation: title/pin/archive, same shape as
--                   chats.sql's chats table)
--   meetings       (EXISTING, unchanged shape - one row per recording/result; gets exactly one new column:
--                   meeting_chat_id, the FK to its parent)
--
-- Why a new table instead of reusing chats/messages: meeting content must never mix with normal Translation
-- chat history (see chats.sql) - a completely separate table makes that structurally impossible, not just a
-- convention to remember. A meeting RESULT already has its own dedicated `meetings` table with a shape nothing
-- like `messages` (transcript/translation/summary/status/duration, not role/content), so nothing there is
-- duplicated either - this migration only adds the missing PARENT layer.
--
-- Backward compatible: meeting_chat_id is nullable, so any meeting rows that existed before this migration are
-- left exactly as they are (they simply won't appear inside any Meeting Chat's timeline).

create table if not exists public.meeting_chats (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null default 'New meeting',
  is_pinned    boolean not null default false,
  is_archived  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.meeting_chats add column if not exists title        text        not null default 'New meeting';
alter table public.meeting_chats add column if not exists is_pinned    boolean     not null default false;
alter table public.meeting_chats add column if not exists is_archived  boolean     not null default false;
alter table public.meeting_chats add column if not exists created_at   timestamptz not null default now();
alter table public.meeting_chats add column if not exists updated_at   timestamptz not null default now();
alter table public.meeting_chats alter column id          set default gen_random_uuid();
alter table public.meeting_chats alter column user_id     set default auth.uid();
alter table public.meeting_chats alter column title       set default 'New meeting';
alter table public.meeting_chats alter column is_pinned   set default false;
alter table public.meeting_chats alter column is_archived set default false;
alter table public.meeting_chats alter column created_at  set default now();
alter table public.meeting_chats alter column updated_at  set default now();

create index if not exists meeting_chats_user_order_idx on public.meeting_chats (user_id, is_pinned desc, updated_at desc);

-- Link each meeting result to its parent Meeting Chat. "on delete cascade" is what makes deleting a Meeting Chat
-- remove its meeting results too, not just hide them (see the app's delete-meeting-chat behavior).
alter table public.meetings add column if not exists meeting_chat_id uuid references public.meeting_chats (id) on delete cascade;
create index if not exists meetings_chat_order_idx on public.meetings (meeting_chat_id, created_at asc);

-- ---------- row-level security: same owner-only pattern as chats.sql ----------
alter table public.meeting_chats enable row level security;

drop policy if exists "Users manage their own meeting chats" on public.meeting_chats;

create policy "Users manage their own meeting chats"
  on public.meeting_chats for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- move a Meeting Chat to the top of "Recents" whenever a new result is added to it ----------
-- Mirrors chats.sql's touch_chat_on_message trigger exactly, just for meetings -> meeting_chats.
create or replace function public.touch_meeting_chat_on_result()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.meeting_chat_id is not null then
    update public.meeting_chats set updated_at = now() where id = new.meeting_chat_id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_meeting_result_created on public.meetings;
create trigger on_meeting_result_created
  after insert on public.meetings
  for each row execute function public.touch_meeting_chat_on_result();

-- Make the API notice the new table/column straight away.
notify pgrst, 'reload schema';
