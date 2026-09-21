// Turns any failure (axios, fetch, backend detail text) into one short message a user can act on.
export const MESSAGES = {
  network: 'Unable to reach the server. Please check your internet connection and try again.',
  timeout: 'The server is taking too long to respond. Please check your connection and try again.',
  session: 'Your session has expired. Please log in again.',
  busy: 'TranslyAi is very busy right now (AI usage limit reached). Please wait a minute and try again.',
  database: 'Unable to connect to database. Please check your connection.',
  databaseSetup: 'The chat database is not set up correctly yet. Please contact the site administrator.',
  transcription: "We couldn't transcribe that audio. Please try again or record a clearer clip.",
  server: 'Something went wrong on our side. Please try again in a moment.',
  generic: 'Something went wrong. Please try again.',
};

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);
const QUOTA = /quota|rate.?limit|resource.?exhausted|too many requests/i;
const DB_SETUP = /out of date|run supabase|missing tables|schema|does not exist|refused/i;
const DB = /chat storage|chat tables|database|supabase|postgrest|chats?\b.*(unavailable|failed)/i;
const STT = /groq|transcri|speech|whisper/i;

export function describeError(error, fallback = MESSAGES.generic) {
  const status = error?.response?.status ?? error?.status;
  const rawDetail = error?.response?.data?.detail ?? error?.detail;
  const detail = typeof rawDetail === 'string' ? rawDetail : '';
  const message = detail || error?.message || '';
  // The exact cause stays in the console for debugging while the screen shows the friendly text.
  console.warn('[TranslyAi] request failed:', status ?? error?.code ?? '', message);

  if (!status) {
    if (TIMEOUT_CODES.has(error?.code) || /timed? ?out/i.test(message)) return MESSAGES.timeout;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline || error?.code === 'ERR_NETWORK' || (error?.request && !error?.response) || error instanceof TypeError) return MESSAGES.network;
    if (/session has expired|jwt expired/i.test(message)) return MESSAGES.session;
    return message && message.length <= 160 ? message : fallback;
  }

  if (status === 401 || /jwt expired|session has expired/i.test(message)) return MESSAGES.session;
  if (status === 429 || QUOTA.test(message)) return MESSAGES.busy;
  if (DB_SETUP.test(message) && /chat|table|supabase|column/i.test(message)) return MESSAGES.databaseSetup;
  if (DB.test(message) || (status === 503 && /chat|storage/i.test(message))) return MESSAGES.database;
  if (status === 504 || status === 408) return MESSAGES.timeout;
  if (status >= 500) return STT.test(message) ? MESSAGES.transcription : MESSAGES.server;
  if (status === 413) return 'That file is too large. Please use a smaller audio clip (25 MB maximum).';
  if (status === 422) return 'That request was not valid. Please check your input and try again.';
  return detail && detail.length <= 160 ? detail : fallback;
}

export const isBusyResult = (translation) => /temporarily unavailable/i.test(translation || '');
