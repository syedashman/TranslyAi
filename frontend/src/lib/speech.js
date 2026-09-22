// Reads assistant responses aloud with the browser's own window.speechSynthesis - entirely client-side, free,
// and the text never leaves the browser (no backend call, no API key). One module-level "session" tracks which
// message (if any) is currently speaking, so only one message can ever be speaking at a time across the whole app.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
export const isSpeechSupported = Boolean(synth);

// Some browsers (notably Chrome) can behave inconsistently with a single very long utterance, so long text is
// split into utterance-sized chunks and queued - speechSynthesis plays queued utterances back to back on its
// own. This never changes the spoken text itself: chunks are cut on sentence/word boundaries only, and the exact
// original text is preserved word for word.
const MAX_CHUNK_CHARS = 200;
function splitIntoChunks(text) {
  const sentences = text.match(/[^.!?\n]+[.!?]*(?:\s+|\n+|$)/g) || [text];
  const chunks = [];
  for (const sentence of sentences) {
    if (sentence.length <= MAX_CHUNK_CHARS) { chunks.push(sentence); continue; }
    let buffer = '';
    for (const word of sentence.split(/(\s+)/)) {
      if (buffer && (buffer + word).length > MAX_CHUNK_CHARS) { chunks.push(buffer); buffer = word; }
      else buffer += word;
    }
    if (buffer) chunks.push(buffer);
  }
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

// Resolved lazily (voice lists load asynchronously in some browsers) and cached; undefined = not looked up yet.
let englishVoice;
function pickEnglishVoice() {
  if (englishVoice !== undefined) return englishVoice;
  const voices = synth.getVoices();
  if (!voices.length) return null; // not loaded yet; utterance.lang alone still picks a sensible default voice
  englishVoice = voices.find((voice) => /^en-US/i.test(voice.lang)) || voices.find((voice) => /^en/i.test(voice.lang)) || null;
  return englishVoice;
}
if (synth) {
  synth.getVoices(); // kicks off async voice loading in browsers that need it
  synth.addEventListener('voiceschanged', () => { englishVoice = undefined; }, { once: true });
}

let session = null; // { id, token, status: 'playing' | 'paused' } for whichever message is current, else null
let nextToken = 0;
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

export function speechStatusFor(id) { return session && session.id === id ? session.status : 'idle'; }
export function subscribeSpeech(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export function stopSpeech() {
  if (!synth) return;
  session = null;
  synth.cancel(); // fires a harmless 'interrupted'/'canceled' onerror on whatever utterance was in flight
  notify();
}

// Starts, pauses, or resumes message `id`'s speech, per the exact click behavior described in the task:
// same message + playing -> pause in place; same message + paused -> resume in place; any other message
// (or idle) -> stop whatever else was speaking and start this one from the beginning.
export function toggleSpeech(id, text) {
  if (!synth || !text) return;

  if (session && session.id === id) {
    if (session.status === 'playing') { synth.pause(); session.status = 'paused'; notify(); }
    else { synth.resume(); session.status = 'playing'; notify(); }
    return;
  }

  synth.cancel();
  const token = ++nextToken;
  session = { id, token, status: 'playing' };
  const voice = pickEnglishVoice();

  splitIntoChunks(text).forEach((chunk, index, chunks) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = 'en-US';
    if (voice) utterance.voice = voice;
    // Only the first/last chunk drive the message-level status; the ones in between just play through.
    if (index === 0) utterance.onstart = () => { if (session?.token === token) { session.status = 'playing'; notify(); } };
    if (index === chunks.length - 1) utterance.onend = () => { if (session?.token === token) { session = null; notify(); } };
    utterance.onerror = (event) => {
      if (event.error === 'interrupted' || event.error === 'canceled') return; // our own cancel(), not a real failure
      if (session?.token === token) { session = null; notify(); }
    };
    synth.speak(utterance);
  });

  notify(); // optimistic: the button flips to "pause" immediately on click rather than waiting for onstart
}
