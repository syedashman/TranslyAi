-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once. Separate from chats/messages (see chats.sql) on purpose: a meeting record is not a
-- chat message, and mixing 30-100 minute transcripts into the messages table would bloat every chat query.
--
-- Optional: the backend's in-memory job registry is the source of truth for a meeting actually being processed
-- (see backend/app/services/meeting_jobs.py) - it works without this table at all. This table is a best-effort,
-- durable MIRROR of that state, written only when SUPABASE_SERVICE_ROLE_KEY is configured in the backend's .env.
-- Running this migration is still recommended so results survive a server restart, but the meeting feature will
-- function without it (you just lose durability across restarts).

create table if not exists public.meetings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users (id) on delete cascade,
  status            text not null default 'queued'
                       check (status in ('queued','uploading','transcribing','translating','summarizing','completed','failed')),
  duration_seconds  integer,
  transcript        text,
  translation       text,
  summary           text,
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.meetings add column if not exists status           text        not null default 'queued';
alter table public.meetings add column if not exists duration_seconds integer;
alter table public.meetings add column if not exists transcript       text;
alter table public.meetings add column if not exists translation      text;
alter table public.meetings add column if not exists summary          text;
alter table public.meetings add column if not exists error_message    text;
alter table public.meetings add column if not exists created_at       timestamptz not null default now();
alter table public.meetings add column if not exists updated_at       timestamptz not null default now();

-- Optional, additive: where a meeting result came from ('recording', 'upload' or 'live' for Live Meeting). Nullable
-- with a default, so every existing row and every insert that omits it keeps working; Live Meeting still saves
-- without this column (the backend retries the write without it), it just won't be tagged as live.
alter table public.meetings add column if not exists source_type      text default 'recording';
alter table public.meetings drop constraint if exists meetings_source_type_check;
alter table public.meetings add constraint meetings_source_type_check
  check (source_type is null or source_type in ('recording','upload','live'));

create index if not exists meetings_user_order_idx on public.meetings (user_id, created_at desc);

-- ---------- row-level security: each user only sees their own meetings ----------
-- The backend writes with the service-role key, which bypasses RLS entirely (by design, for the reason above),
-- so these policies only ever govern what a signed-in USER can read/write directly - never the backend's own
-- mirrored writes.
alter table public.meetings enable row level security;

drop policy if exists "Users manage their own meetings" on public.meetings;

create policy "Users manage their own meetings"
  on public.meetings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Make the API notice the new table straight away.
notify pgrst, 'reload schema';
