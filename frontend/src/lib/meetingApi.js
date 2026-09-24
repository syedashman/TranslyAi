import axios from 'axios';
import { API_BASE_URL } from './config';
import { supabase } from './supabase';
import { describeError, MESSAGES } from './errors';

// Meetings require a signed-in session (same as saved chats) - a meeting record is owned, longer-lived data,
// not a one-off translation. This mirrors chatApi.js's call() pattern rather than reusing it directly, since
// starting a meeting needs a multipart/form-data body instead of JSON.
async function authHeader() {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error(MESSAGES.session);
  return { Authorization: `Bearer ${token}` };
}

function wrapError(error) {
  const wrapped = new Error(describeError(error));
  wrapped.status = error?.response?.status ?? error?.status;
  return wrapped;
}

// Uploads the finalized recording and returns { id, status, meeting_chat_id } immediately - the backend processes
// it as a background task, so this call itself only has to wait for the upload, not the full transcription/
// translation. Pass an existing Meeting Chat's id to add another result to it; omit it (null/undefined) to have
// the backend create a brand-new Meeting Chat on the fly for this recording - either way the response says which
// chat the result landed in.
export async function startMeeting(file, durationSeconds, meetingChatId, { signal } = {}) {
  const headers = await authHeader();
  const formData = new FormData();
  formData.append('file', file);
  if (durationSeconds != null) formData.append('duration_seconds', String(Math.round(durationSeconds)));
  if (meetingChatId) formData.append('meeting_chat_id', meetingChatId);
  try {
    const response = await axios.post(`${API_BASE_URL}/api/meetings`, formData, {
      headers: { ...headers, 'Content-Type': 'multipart/form-data' },
      timeout: 5 * 60 * 1000, // the upload itself, not the processing, which happens after this responds
      signal,
    });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}

// Current stage while processing (queued/transcribing/translating/summarizing), or the finished
// translation/summary once status is "completed", or error_message if "failed". Never includes the transcript -
// the backend's response model deliberately excludes it (stored, never sent to the frontend).
export async function getMeetingStatus(meetingId, { signal } = {}) {
  const headers = await authHeader();
  try {
    const response = await axios.get(`${API_BASE_URL}/api/meetings/${meetingId}/status`, { headers, timeout: 30000, signal });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}

// ---------- Meeting Chats: the persistent container a recording is saved into (Meetings sidebar tab) ----------
// Mirrors chatApi.js's /chats functions - same shapes (id/title/is_pinned/is_archived/created_at/updated_at),
// same pin/archive/delete/title behavior, just talking to /api/meeting-chats instead of /api/chats.

export async function listMeetingChats({ signal } = {}) {
  const headers = await authHeader();
  try {
    const response = await axios.get(`${API_BASE_URL}/api/meeting-chats`, { headers, params: { archived: 'all' }, timeout: 60000, signal });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}

// "New chat" while the Meetings tab is selected - an empty conversation, shown immediately in the sidebar even
// before anything has been recorded into it.
export async function createMeetingChat() {
  const headers = await authHeader();
  try {
    const response = await axios.post(`${API_BASE_URL}/api/meeting-chats`, {}, { headers, timeout: 30000 });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}

export async function setMeetingChatPinned(chatId, value) {
  const headers = await authHeader();
  try {
    const response = await axios.patch(`${API_BASE_URL}/api/meeting-chats/${chatId}/pin`, { value }, { headers, timeout: 30000 });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}

export async function setMeetingChatArchived(chatId, value) {
  const headers = await authHeader();
  try {
    const response = await axios.patch(`${API_BASE_URL}/api/meeting-chats/${chatId}/archive`, { value }, { headers, timeout: 30000 });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}

export async function deleteMeetingChat(chatId) {
  const headers = await authHeader();
  try {
    await axios.delete(`${API_BASE_URL}/api/meeting-chats/${chatId}`, { headers, timeout: 30000 });
  } catch (error) {
    throw wrapError(error);
  }
}

// Asks the backend for a short AI title, generated from the Meeting Chat's first result's summary. A chat that
// already has a title is returned unchanged (see TitleService.is_untitled on the backend), so this is safe to
// call after every completed recording without ever renaming a chat twice.
export async function generateMeetingChatTitle(chatId, text) {
  const headers = await authHeader();
  try {
    const response = await axios.post(`${API_BASE_URL}/api/meeting-chats/${chatId}/title`, { text: text.slice(0, 2000) }, { headers, timeout: 60000 });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}

// Every completed result inside one Meeting Chat, oldest first - the conversation-like timeline MeetingChat.jsx
// renders (translation + summary per result; never a transcript).
export async function listMeetingChatResults(chatId, { signal } = {}) {
  const headers = await authHeader();
  try {
    const response = await axios.get(`${API_BASE_URL}/api/meeting-chats/${chatId}/meetings`, { headers, timeout: 30000, signal });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}
