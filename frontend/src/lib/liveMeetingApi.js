import axios from 'axios';
import { API_BASE_URL, WEB_ORIGIN } from './config';
import { isNative } from './native';
import { supabase } from './supabase';
import { describeError, MESSAGES } from './errors';

// Live Meeting client: one REST call to create the session (validates/creates the Meeting Chat, same ownership
// rules as recordings) and a native WebSocket for audio-in / events-out. No third-party realtime service.

async function accessToken() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error(MESSAGES.session);
  return token;
}

export async function createLiveMeeting(meetingChatId) {
  const token = await accessToken();
  try {
    const response = await axios.post(
      `${API_BASE_URL}/api/live-meetings`,
      meetingChatId ? { meeting_chat_id: meetingChatId } : {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 },
    );
    return response.data; // { id, status, meeting_chat_id }
  } catch (error) {
    const wrapped = new Error(describeError(error, "Couldn't start the live meeting. Please try again."));
    wrapped.status = error?.response?.status;
    throw wrapped;
  }
}

// Cancel = DISCARD (nothing is saved). Retried a couple of times over REST because a cancel that never arrives would
// let the server finalize and SAVE the meeting once its reconnect grace runs out. Resolves true when the server
// confirms; rejects with a user-facing message if it could not be confirmed or the meeting was already saved.
export async function cancelLiveMeeting(meetingId) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const token = await accessToken();
      await axios.post(`${API_BASE_URL}/api/live-meetings/${meetingId}/cancel`, {}, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
      return true;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 409) {
        const saved = new Error('This meeting was already saved, so it could not be cancelled. You can find it in your Meeting Chat.');
        saved.code = 'already_saved';
        throw saved;
      }
      if (status === 404) return true; // already gone on the server (finished/cancelled/expired): nothing left to discard
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw new Error(describeError(lastError, "Couldn't confirm the cancellation. Check your connection - the meeting may still be saved if it isn't cancelled."));
}

const wsUrl = (meetingId) => `${API_BASE_URL.replace(/^http/i, 'ws')}/ws/live-meeting/${meetingId}`;

const MAX_RECONNECTS = 5;
const HEARTBEAT_MS = 15000;
const READY_TIMEOUT_MS = 15000;
const MAX_BUFFERED_BYTES = 1024 * 1024; // never queue more than ~1 MB of audio in the socket - drop instead
const CLOSE_UNAUTHORIZED = 4401;
const TERMINAL_EVENTS = new Set(['completed', 'failed', 'cancelled']);

// handlers: onEvent(event), onStatus('connecting' | 'live' | 'reconnecting'), onGiveUp(message).
// The socket never re-creates the meeting: a reconnect re-attaches to the same server-side session by id, and the
// server replays the segments so nothing is duplicated or lost.
export class LiveMeetingSocket {
  constructor(meetingId, handlers) {
    this.meetingId = meetingId;
    this.handlers = handlers;
    this.ws = null;
    this.ready = false;
    this.intentionalClose = false;
    this.terminal = false;
    this.attempts = 0;
    this.heartbeat = null;
    this.retryTimer = null;
  }

  // Resolves once the server has acknowledged the session ("ready"); rejects with a user-facing message otherwise.
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Could not connect to the live meeting service. Please try again.')); this.close(); } }, READY_TIMEOUT_MS);
      this.firstReady = () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(); } };
      this.firstFail = (message) => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(message)); } };
      this.open();
    });
  }

  async open() {
    this.ready = false;
    let token;
    try { token = await accessToken(); }
    catch (error) { this.giveUp(error.message); return; }
    if (this.intentionalClose) return;

    const ws = new WebSocket(wsUrl(this.meetingId));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.handlers.onStatus?.(this.attempts ? 'reconnecting' : 'connecting');

    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    ws.onmessage = (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      if (event.type === 'ready') {
        this.ready = true;
        this.attempts = 0;
        this.startHeartbeat();
        this.handlers.onStatus?.('live');
        this.firstReady?.();
      }
      if (TERMINAL_EVENTS.has(event.type) || (event.type === 'error' && event.fatal)) this.terminal = true;
      this.handlers.onEvent?.(event);
    };
    ws.onclose = (event) => {
      this.ready = false;
      this.stopHeartbeat();
      if (this.intentionalClose || this.terminal) return;
      if (event.code === CLOSE_UNAUTHORIZED) { this.giveUp('The live meeting connection was refused.'); return; }
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows and drives reconnect/give-up */ };
  }

  scheduleReconnect() {
    if (this.attempts >= MAX_RECONNECTS) { this.giveUp('The live meeting connection was lost.'); return; }
    this.attempts += 1;
    this.handlers.onStatus?.('reconnecting');
    const delay = Math.min(1000 * 2 ** (this.attempts - 1), 15000);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  giveUp(message) {
    this.firstFail?.(message);
    if (!this.intentionalClose) this.handlers.onGiveUp?.(message);
    this.close();
  }

  // Audio is only sent once the session is attached; while reconnecting it is dropped rather than buffered, so a
  // long outage can never grow browser memory (the server keeps what it already transcribed).
  sendAudio(buffer) {
    const ws = this.ws;
    if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
    ws.send(buffer);
  }

  sendStop() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stop' }));
  }

  // Pause / resume travel over the host's socket only. They resolve false when the message could not be sent (the socket is
  // down), so the UI never claims a state the server did not receive.
  sendPause() {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.ready) return false;
    this.ws.send(JSON.stringify({ type: 'pause' }));
    return true;
  }

  sendResume() {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.ready) return false;
    this.ws.send(JSON.stringify({ type: 'resume' }));
    return true;
  }

  sendCancel() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cancel' }));
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping' }));
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
  }

  close() {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) { try { ws.close(1000); } catch { /* already closing */ } }
  }
}

// ---------- sharing: read-only viewers (guests need no account) ----------

// The link the host sends around. Same "?param=" pattern the app already uses for chats (?chatId=), so it needs no
// server routing config on any host. On the Android app the internal Capacitor origin is swapped for the public site.
export const buildShareUrl = (shareToken) => `${isNative ? WEB_ORIGIN : window.location.origin}/?live=${encodeURIComponent(shareToken)}`;

export function readLiveTokenFromUrl() {
  try {
    const token = new URLSearchParams(window.location.search).get('live');
    return token && /^[A-Za-z0-9_-]{20,128}$/.test(token) ? token : null;
  } catch { return null; }
}

// A viewer never sends anything but heartbeats: there is no audio, stop or auth path for them at all.
// handlers: onEvent(event), onStatus('connecting' | 'live' | 'reconnecting'), onUnavailable().
export class LiveViewerSocket {
  constructor(shareToken, handlers) {
    this.shareToken = shareToken;
    this.handlers = handlers;
    this.ws = null;
    this.attempts = 0;
    this.closed = false;
    this.finished = false;
    this.heartbeat = null;
    this.retryTimer = null;
  }

  connect() {
    if (this.closed) return;
    this.handlers.onStatus?.(this.attempts ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`${API_BASE_URL.replace(/^http/i, 'ws')}/ws/live-view/${encodeURIComponent(this.shareToken)}`);
    this.ws = ws;
    ws.onmessage = (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      if (event.type === 'ready') { this.attempts = 0; this.handlers.onStatus?.('live'); this.startHeartbeat(); }
      if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') this.finished = true;
      this.handlers.onEvent?.(event);
    };
    ws.onclose = (event) => {
      this.stopHeartbeat();
      if (this.closed) return;
      if (event.code === 4404) { this.handlers.onUnavailable?.(); return; }
      if (event.code === 4429) { this.handlers.onUnavailable?.('full'); return; }
      if (this.finished) return; // the meeting is over and its result was delivered - nothing to reconnect for
      // Reconnecting re-attaches to the SAME session: the server replays the current state, so nothing is
      // duplicated or missed and no second transcription session is ever started.
      this.attempts += 1;
      this.handlers.onStatus?.('reconnecting');
      this.retryTimer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** Math.min(this.attempts - 1, 4), 15000));
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping' })); }, 15000);
  }

  stopHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }

  close() {
    this.closed = true;
    this.stopHeartbeat();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) { try { ws.close(1000); } catch { /* already closing */ } }
  }
}

// ---------- "Sign up to save your meeting": a guest's claim survives signup / login / OAuth redirects ----------

const PENDING_CLAIM_KEY = 'translyai-pending-live-claim';

export function savePendingClaim(claimToken) {
  try { localStorage.setItem(PENDING_CLAIM_KEY, JSON.stringify({ claimToken, savedAt: Date.now() })); } catch { /* storage blocked: the in-page flow still works */ }
}
export function readPendingClaim() {
  try { return JSON.parse(localStorage.getItem(PENDING_CLAIM_KEY) || 'null')?.claimToken || null; } catch { return null; }
}
export function clearPendingClaim() {
  try { localStorage.removeItem(PENDING_CLAIM_KEY); } catch { /* nothing to clear */ }
}

// Saves a COPY of the one meeting the claim token was issued for into the signed-in user's own account.
// Resolves { meeting_chat_id, meeting_id, already_saved, summary }.
export async function claimLiveMeeting(claimToken) {
  const token = await accessToken();
  try {
    const response = await axios.post(`${API_BASE_URL}/api/live-share/claim`, { claim_token: claimToken },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    return response.data;
  } catch (error) {
    const wrapped = new Error(describeError(error, "Couldn't save the meeting. Please try again."));
    wrapped.status = error?.response?.status;
    throw wrapped;
  }
}
