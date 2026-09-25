import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Copy, LoaderCircle, Mail, Mic, Pause, Play, Square, Upload, Users } from 'lucide-react';
import { formatDuration } from './lib/duration';
import { buildEmailBody, openGmailCompose } from './lib/email';
import { describeError } from './lib/errors';
import {
  generateMeetingChatTitle, getMeetingStatus, listMeetingChatResults, startMeeting, uploadMeetingRecording,
} from './lib/meetingApi';

// "Upload Recording" file picker - video is the main new feature (its audio track is extracted server-side via
// FFmpeg, see backend/app/services/video.py); plain audio files already work with the existing pipeline as-is.
const UPLOAD_ACCEPT = 'video/mp4,video/quicktime,video/webm,audio/*';

// AbortController-based cancellation surfaces as a DOMException named 'AbortError' or axios' own 'CanceledError'.
function isCancelError(error) {
  return error?.name === 'AbortError' || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED';
}

const POLL_INTERVAL_MS = 4000;
// Browsers periodically flush MediaRecorder's internal buffer to ondataavailable on this cadence instead of
// holding everything until stop() - keeps chunk sizes bounded for a 30-100 minute recording.
const RECORDER_TIMESLICE_MS = 10000;
const CANDIDATE_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];

const STAGE_LABEL = {
  queued: 'Queued for processing...',
  uploading: 'Uploading recording...',
  extracting_audio: 'Extracting audio...',
  transcribing: 'Transcribing...',
  translating: 'Translating...',
  summarizing: 'Summarizing...',
};

function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

// One saved result inside the Meeting Chat's timeline - Translation + Summary only, same Copy/Email behavior as
// the live "just completed" card had before. Never renders a transcript (the backend never even sends one).
function MeetingResultCard({ result, onCopy }) {
  const copyAll = () => onCopy(buildEmailBody(result.translation, result.summary), 'Meeting result copied');
  const emailAll = () => openGmailCompose('TranslyAI Meeting', buildEmailBody(result.translation, result.summary));
  return (
    <div className="meeting-result">
      <div className="meeting-result-actions">
        <button type="button" className="mini-action" aria-label="Copy meeting result" title="Copy" onClick={copyAll}><Copy size={14} /></button>
        <button type="button" className="mini-action" aria-label="Email meeting result" title="Email" onClick={emailAll}><Mail size={14} /></button>
      </div>
      <div className="translation-card">
        <div className="result-heading"><span>English translation</span></div>
        {result.translation.split(/\n{2,}/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </div>
      <div className="summary-card">
        <div className="summary-heading"><Users size={14} />Meeting summary</div>
        <p>{result.summary}</p>
      </div>
    </div>
  );
}

// Meeting Chat: an inline mode of the chat area (rendered by App.jsx in place of the normal .conversation +
// composer, not as an overlay) - self-contained, with its own MediaRecorder refs, entirely separate from the
// short-voice recording flow in App.jsx, so nothing here can interfere with that existing feature.
//
// A Meeting Chat is a persistent container that can hold multiple recordings: this shows every previously saved
// result in order, with a "Start Meeting" control always available at the bottom to record another one into the
// SAME chat. There is deliberately no close/X button here - leaving Meeting Chat mode only happens by picking a
// different chat or starting a new one from the sidebar (see App.jsx's openChat/resetToNewChat).
//
// chatId is null only for a brand-new, not-yet-saved Meeting Chat (the empty "Start Meeting" state right after
// clicking "New chat" on the Meetings tab) - the very first recording gets the backend to create the chat, and
// onChatCreated tells App.jsx the new id so later recordings in the same session attach to it instead of each
// creating their own new chat.
export default function MeetingChat({ chatId = null, onCopy, onChatCreated, onResultSaved }) {
  const [results, setResults] = useState([]);
  const [resultsLoading, setResultsLoading] = useState(Boolean(chatId));
  const [resultsError, setResultsError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [phase, setPhase] = useState('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState('');
  const [canPause, setCanPause] = useState(true);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]); // plain array ref, not React state - never re-renders on every chunk, never duplicated
  const mimeTypeRef = useRef('');
  const timerRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const pollAbortRef = useRef(null);
  const finalizedFileRef = useRef(null); // kept so a failed RECORDING upload can be retried without re-recording
  const pickedFileRef = useRef(null); // kept so a failed FILE upload can be retried without re-picking
  const uploadInputRef = useRef(null);
  const closedRef = useRef(false);
  const chatIdRef = useRef(chatId); // the id to attach the NEXT recording to - starts at the prop, updated once a brand-new chat is created

  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  const startTimer = () => { stopTimer(); timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000); };

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const stopPolling = () => {
    if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null; }
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
  };

  // Stop the mic and any in-flight polling if this unmounts mid-meeting (App.jsx keys MeetingChat by chatId, so
  // switching to a different Meeting Chat - or leaving Meeting Chat mode entirely - unmounts this first) - a
  // recording must never keep running invisibly in the background.
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      stopTimer();
      stopPolling();
      releaseStream();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* already stopping */ } }
    };
  }, []);

  // Existing Meeting Chat: load every previously saved result once, oldest first, so it reads like a
  // conversation. A brand-new chat (chatId null) has nothing to fetch - it starts empty.
  useEffect(() => {
    if (!chatId) { setResults([]); setResultsLoading(false); return undefined; }
    let cancelled = false;
    setResultsLoading(true); setResultsError('');
    (async () => {
      try {
        const rows = await listMeetingChatResults(chatId);
        if (cancelled) return;
        setResults(rows.map((row) => ({ id: row.id, translation: row.translation || '', summary: row.summary || '' })));
      } catch (fetchError) {
        if (cancelled) return;
        setResultsError(describeError(fetchError, "Couldn't load this meeting chat. Please try again."));
      } finally {
        if (!cancelled) setResultsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [chatId, reloadTick]);

  const startRecording = async () => {
    setError('');
    if (typeof MediaRecorder === 'undefined') { setError('Recording is not supported in this browser.'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setError('Microphone recording is not supported in this browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
      });
      const mimeType = pickSupportedMimeType();
      mimeTypeRef.current = mimeType;
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      setCanPause(typeof recorder.pause === 'function' && typeof recorder.resume === 'function');

      recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = (event) => {
        console.warn('[TranslyAI] meeting recorder error:', event.error);
        setError('Recording failed unexpectedly. Please try again.');
        stopTimer();
        releaseStream();
        setPhase('error');
      };
      recorder.onstop = () => { releaseStream(); handleRecordingFinished(); };

      recorder.start(RECORDER_TIMESLICE_MS);
      setElapsedSeconds(0);
      startTimer();
      setPhase('recording');
    } catch {
      setError('Microphone access was not granted.');
    }
  };

  const pauseRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    try { recorder.pause(); stopTimer(); setPhase('paused'); }
    catch { setError('Pausing is not supported in this browser - you can still stop and finish the meeting.'); }
  };

  const resumeRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'paused') return;
    try { recorder.resume(); startTimer(); setPhase('recording'); }
    catch { setError('Resuming failed. Please stop and finish the meeting.'); }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    stopTimer();
    if (!recorder || recorder.state === 'inactive') return;
    // The actual finalize-and-upload happens in onstop once the browser has flushed the last chunk - stopping
    // is asynchronous, so nothing here assumes the recording is already finished.
    recorder.stop();
  };

  const handleRecordingFinished = async () => {
    if (closedRef.current) return;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (!chunks.length) { setError('No audio was captured. Please try again.'); setPhase('error'); return; }
    const blob = new Blob(chunks, { type: mimeTypeRef.current || 'audio/webm' });
    if (!blob.size) { setError('No audio was captured. Please try again.'); setPhase('error'); return; }
    const extension = mimeTypeRef.current.includes('mp4') ? 'mp4' : mimeTypeRef.current.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([blob], `meeting.${extension}`, { type: blob.type });
    finalizedFileRef.current = file;
    await uploadAndProcess(file);
  };

  const uploadAndProcess = async (file) => {
    setPhase('uploading'); setError('');
    try {
      const { id, meeting_chat_id: savedChatId } = await startMeeting(file, elapsedSeconds, chatIdRef.current);
      if (closedRef.current) return;
      pollStatus(id, savedChatId);
    } catch (uploadError) {
      if (closedRef.current) return;
      setError(describeError(uploadError, 'Upload failed. Please try again.'));
      setPhase('error');
    }
  };

  // "Upload Recording": a video or audio file already on the user's device, instead of a live browser recording.
  // Reuses the exact same pollStatus/results-append/title-generation flow below - the backend hands back the
  // same { id, meeting_chat_id } shape either way, so nothing past this point needs to know which path was used.
  const openUploadPicker = () => { setError(''); uploadInputRef.current?.click(); };

  const uploadPickedFile = async (file) => {
    setPhase('uploading'); setError('');
    pickedFileRef.current = file;
    try {
      const { id, meeting_chat_id: savedChatId } = await uploadMeetingRecording(file, chatIdRef.current);
      if (closedRef.current) return;
      pollStatus(id, savedChatId);
    } catch (uploadError) {
      if (closedRef.current) return;
      setError(describeError(uploadError, 'Upload failed. Please try again.'));
      setPhase('error');
    }
  };

  const handleFileSelected = (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow picking the exact same file again later
    if (file) uploadPickedFile(file);
  };

  // Named jobId (not chatId) - this is always the id of a job just created by uploadAndProcess.
  const pollStatus = (jobId, savedChatId) => {
    const poll = async () => {
      if (closedRef.current) return;
      const controller = new AbortController();
      pollAbortRef.current = controller;
      try {
        const status = await getMeetingStatus(jobId, { signal: controller.signal });
        if (closedRef.current) return;
        if (status.status === 'completed') {
          // No transcript field is ever returned by the backend (see MeetingStatusResponse) - stored, never sent.
          const translation = status.translation || '';
          const summary = status.summary || '';
          // results here is the list as it stood when this recording started (a stable closure, not the latest
          // state) - exactly "did this chat have zero completed results before this one", which is what decides
          // whether to name it, whether the chat was brand-new or an existing one that had never completed one.
          const wasFirstResult = results.length === 0;
          setResults((current) => [...current, { id: jobId, translation, summary }]);
          setPhase('idle');
          setElapsedSeconds(0);
          finalizedFileRef.current = null;
          pickedFileRef.current = null;

          if (!chatIdRef.current) {
            // This was the very first recording of a brand-new Meeting Chat - the backend just created it.
            chatIdRef.current = savedChatId;
            onChatCreated?.(savedChatId);
          }
          if (wasFirstResult) {
            // Name the chat from its first result - reuses the exact same Gemini title service as normal chats;
            // is_untitled on the backend makes this a safe no-op if it somehow ran twice.
            generateMeetingChatTitle(savedChatId, summary)
              .catch((titleError) => console.warn('Meeting title generation skipped:', titleError.message));
          }
          onResultSaved?.(savedChatId);
          return;
        }
        if (status.status === 'failed') {
          setError(status.error_message || 'Meeting processing failed. Please try again.');
          setPhase('error');
          return;
        }
        setPhase(status.status || 'queued');
        pollTimeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (pollError) {
        if (closedRef.current || isCancelError(pollError)) return;
        setError(describeError(pollError, "Couldn't check the meeting's progress. Please try again."));
        setPhase('error');
      }
    };
    poll();
  };

  const retryUpload = () => {
    if (pickedFileRef.current) uploadPickedFile(pickedFileRef.current);
    else if (finalizedFileRef.current) uploadAndProcess(finalizedFileRef.current);
    else { setError(''); setPhase('idle'); }
  };

  const isRecordingPhase = phase === 'recording' || phase === 'paused';
  const isProcessingPhase = phase === 'uploading' || Boolean(STAGE_LABEL[phase]);
  const hasResults = results.length > 0;

  return (
    <section className="conversation meeting-chat" aria-live="polite">
      <div className="meeting-head">
        <h2><Users size={18} /> Meeting</h2>
      </div>

      {resultsLoading && (
        <div className="conversation-status"><LoaderCircle size={18} className="spin" />Loading meeting chat...</div>
      )}
      {resultsError && (
        <div className="conversation-status conversation-error">
          {resultsError}
          <button type="button" onClick={() => setReloadTick((tick) => tick + 1)}>Try again</button>
        </div>
      )}

      {!resultsLoading && hasResults && (
        <div className="meeting-results-list">
          {results.map((result) => <MeetingResultCard key={result.id} result={result} onCopy={onCopy} />)}
        </div>
      )}

      {!resultsLoading && !resultsError && phase === 'idle' && (
        <div className="meeting-idle">
          <p>{hasResults
            ? 'Record or upload another part of this meeting - TranslyAI will transcribe, translate, and summarize it and add it to this conversation.'
            : 'Record a meeting (roughly 30-100 minutes) or upload a recorded video/audio file, and TranslyAI will transcribe, translate, and summarize it. Typing is turned off while a meeting is open.'}</p>
          {error && <p className="meeting-error-line"><CircleAlert size={14} />{error}</p>}
          <div className="meeting-controls">
            <button type="button" className="meeting-start-button" onClick={startRecording}><Mic size={16} />Record Meeting</button>
            <button type="button" className="meeting-secondary" onClick={openUploadPicker}><Upload size={16} />Upload Recording</button>
          </div>
          <input
            ref={uploadInputRef} type="file" accept={UPLOAD_ACCEPT} onChange={handleFileSelected} hidden
            aria-label="Upload a recorded meeting video or audio file"
          />
        </div>
      )}

      {isRecordingPhase && (
        <div className="meeting-recording">
          <div className={`meeting-rec-dot ${phase === 'recording' ? 'is-live' : 'is-paused'}`} aria-hidden="true" />
          <div className="meeting-timer">{formatDuration(elapsedSeconds)}</div>
          <div className="meeting-rec-status">{phase === 'recording' ? 'Recording...' : 'Paused'}</div>
          <div className="meeting-controls">
            {phase === 'recording'
              ? <button type="button" className="meeting-secondary" onClick={pauseRecording} disabled={!canPause}><Pause size={16} />Pause</button>
              : <button type="button" className="meeting-secondary" onClick={resumeRecording}><Play size={16} />Resume</button>}
            <button type="button" className="meeting-stop-button" onClick={stopRecording}><Square size={14} />Stop Meeting</button>
          </div>
          {!canPause && <p className="meeting-hint">Pause/resume isn't supported in this browser - Stop Meeting still works.</p>}
        </div>
      )}

      {isProcessingPhase && (
        <div className="meeting-processing">
          <LoaderCircle size={28} className="spin" />
          <p className="meeting-stage">{STAGE_LABEL[phase] || 'Uploading your recording...'}</p>
          <p className="meeting-hint">Your meeting is being processed. This may take a few minutes.</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="meeting-error">
          <CircleAlert size={22} />
          <p>{error || 'Something went wrong.'}</p>
          <div className="meeting-controls">
            {(finalizedFileRef.current || pickedFileRef.current) && <button type="button" className="meeting-secondary" onClick={retryUpload}>Retry upload</button>}
            <button type="button" className="meeting-start-button" onClick={() => { finalizedFileRef.current = null; pickedFileRef.current = null; setError(''); setPhase('idle'); }}>
              {(finalizedFileRef.current || pickedFileRef.current) ? 'Start a new meeting instead' : 'Try again'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
