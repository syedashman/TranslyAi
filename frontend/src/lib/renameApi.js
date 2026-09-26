import { supabase } from './supabase';
import { MESSAGES } from './errors';

// Renaming a chat: one small helper for both kinds of chat (Translation Chats in `chats`, Meeting Chats in `meeting_chats`).
// The backend has no rename endpoint (its /title route only GENERATES a name for an untitled chat), so this updates the
// row's title through the signed-in user's own Supabase session - the same owner-only row-level security that already
// governs every other write to these tables, so nobody can rename a chat that is not theirs. Resolves to the updated row.
export const MAX_TITLE_LENGTH = 120;

async function renameRow(table, chatId, title) {
  if (!supabase) throw new Error(MESSAGES.session);
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error(MESSAGES.session);
  const clean = String(title || '').trim().slice(0, MAX_TITLE_LENGTH);
  if (!clean) throw new Error('A chat name cannot be empty.');
  const { data, error } = await supabase.from(table).update({ title: clean }).eq('id', chatId).select().single();
  if (error || !data) throw new Error("The new name couldn't be saved. Please try again.");
  return data;
}

export const renameChat = (chatId, title) => renameRow('chats', chatId, title);
export const renameMeetingChat = (chatId, title) => renameRow('meeting_chats', chatId, title);
