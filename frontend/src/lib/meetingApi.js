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

// Uploads the finalized recording and returns { id, status } immediately - the backend processes it as a
// background task, so this call itself only has to wait for the upload, not the full transcription/translation.
export async function startMeeting(file, durationSeconds, { signal } = {}) {
  const headers = await authHeader();
  const formData = new FormData();
  formData.append('file', file);
  if (durationSeconds != null) formData.append('duration_seconds', String(Math.round(durationSeconds)));
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

// This user's saved (completed-only) meetings, newest first, for the Meetings history tab. Lightweight rows -
// no translation/transcript - just enough for a list preview (id, status, duration, summary, timestamps).
export async function listMeetings({ signal } = {}) {
  const headers = await authHeader();
  try {
    const response = await axios.get(`${API_BASE_URL}/api/meetings`, { headers, timeout: 30000, signal });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}

// One saved meeting's full stored translation + summary (never the transcript - see getMeetingStatus above).
// A plain read of what the background job already saved; never re-transcribes or re-translates anything.
export async function getMeeting(meetingId, { signal } = {}) {
  const headers = await authHeader();
  try {
    const response = await axios.get(`${API_BASE_URL}/api/meetings/${meetingId}`, { headers, timeout: 30000, signal });
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}
