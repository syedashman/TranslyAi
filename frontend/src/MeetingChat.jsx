import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Copy, LoaderCircle, Mail, Mic, Pause, Play, Square, Users, X } from 'lucide-react';
import { formatDuration } from './lib/duration';
import { buildEmailBody, openGmailCompose } from './lib/email';
import { describeError } from './lib/errors';
import { getMeeting, getMeetingStatus, startMeeting } from './lib/meetingApi';

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
  uploading: 'Uploading your recording...',
  transcribing: 'Transcribing your meeting...',
  translating: 'Translating the transcript...',
  summarizing: 'Generating the summary...',
  'loading-saved': 'Loading saved meeting...',
};

function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

// Meeting Chat: an inline mode of the chat area (rendered by App.jsx in place of the normal .conversation +
// composer, not as an overlay) - self-contained, with its own MediaRecorder refs, entirely separate from the
// short-voice recording flow in App.jsx, so nothing here can interfere with that existing feature.
//
// Two modes, chosen by whether `meetingId` is passed:
// - no meetingId: the normal "Start Meeting" recording flow (unchanged).
// - meetingId set: opens an already-saved meeting from history instead - fetches its stored translation/summary
//   (GET /api/meetings/{id}, never ElevenLabs/Gemini again) and renders the exact same result view, read-only.
export default function MeetingChat({ onClose, onCopy, onSaved, meetingId = null }) {
  const [phase, setPhase] = useState(meetingId ? 'loading-saved' : 'idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { translation, summary } - deliberately never a transcript field
  const [canPause, setCanPause] = useState(true);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]); // plain array ref, not React state - never re-renders on every chunk, never duplicated
  const mimeTypeRef = useRef('');
  const timerRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const pollAbortRef = useRef(null);
  const finalizedFileRef = useRef(null); // kept so a failed upload can be retried without re-recording
  const closedRef = useRef(false);

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

  // Stop the mic and any in-flight polling if Meeting Chat is closed (or App.jsx unmounts it, e.g. by
  // navigating to a different chat) mid-meeting - a recording must never keep running invisibly in the background.
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

  // Saved-meeting mode: fetch the already-stored result once, instead of recording. No ElevenLabs/Gemini call
  // happens here - this is a plain read of what the background job already saved to Supabase.
  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;
    (async () => {
      try {
        const meeting = await getMeeting(meetingId);
        if (cancelled) return;
        setResult({ translation: meeting.translation || '', summary: meeting.summary || '' });
        setPhase('completed');
      } catch (fetchError) {
        if (cancelled) return;
        setError(describeError(fetchError, "Couldn't load that meeting. Please try again."));
        setPhase('error');
      }
    })();
    return () => { cancelled = true; };
  }, [meetingId]);

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
      const { id } = await startMeeting(file, elapsedSeconds);
      if (closedRef.current) return;
      pollStatus(id);
    } catch (uploadError) {
      if (closedRef.current) return;
      setError(describeError(uploadError, 'Upload failed. Please try again.'));
      setPhase('error');
    }
  };

  // Named jobId (not meetingId) to avoid shadowing the meetingId PROP used by saved-view mode above - this is
  // always the id of a job just created by uploadAndProcess, never a previously-saved meeting being reopened.
  const pollStatus = (jobId) => {
    const poll = async () => {
      if (closedRef.current) return;
      const controller = new AbortController();
      pollAbortRef.current = controller;
      try {
        const status = await getMeetingStatus(jobId, { signal: controller.signal });
        if (closedRef.current) return;
        if (status.status === 'completed') {
          // No transcript field is ever returned by the backend (see MeetingStatusResponse) - stored, never sent.
          setResult({ translation: status.translation || '', summary: status.summary || '' });
          setPhase('completed');
          onSaved?.();
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
    if (finalizedFileRef.current) uploadAndProcess(finalizedFileRef.current);
    else { setError(''); setPhase('idle'); }
  };

  const startOver = () => {
    finalizedFileRef.current = null;
    setResult(null);
    setError('');
    setElapsedSeconds(0);
    setPhase('idle');
  };

  const copyAll = () => {
    if (!result) return;
    onCopy(buildEmailBody(result.translation, result.summary), 'Meeting result copied');
  };
  const emailAll = () => {
    if (!result) return;
    openGmailCompose('TranslyAI Meeting', buildEmailBody(result.translation, result.summary));
  };

  const isRecordingPhase = phase === 'recording' || phase === 'paused';
  const isProcessingPhase = phase === 'uploading' || Boolean(STAGE_LABEL[phase]);
  // Can't be dismissed mid-recording or mid-processing - only "Stop Meeting" ends a recording, so the close
  // button can't silently orphan or discard one (App.jsx also never unmounts this on its own during these phases).
  const canCloseFreely = !isRecordingPhase && !isProcessingPhase;

  return (
    <section className="conversation meeting-chat" aria-live="polite">
      <div className="meeting-head">
        <h2><Users size={18} /> {meetingId ? 'Saved meeting' : 'Meeting'}</h2>
        {canCloseFreely && <button type="button" className="share-close" onClick={onClose} aria-label="Close meeting chat" title="Close"><X size={18} /></button>}
      </div>

      {phase === 'idle' && (
        <div className="meeting-idle">
          <p>Record a meeting (roughly 30-100 minutes) and TranslyAI will transcribe, translate, and summarize it once you stop. Typing is turned off while a meeting is open - use Stop Meeting or Close to type again.</p>
          {error && <p className="meeting-error-line"><CircleAlert size={14} />{error}</p>}
          <button type="button" className="meeting-start-button" onClick={startRecording}><Mic size={16} />Start Meeting</button>
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
            {finalizedFileRef.current && <button type="button" className="meeting-secondary" onClick={retryUpload}>Retry upload</button>}
            {meetingId
              ? <button type="button" className="meeting-secondary" onClick={onClose}>Close</button>
              : <button type="button" className="meeting-start-button" onClick={startOver}>Start a new meeting</button>}
          </div>
        </div>
      )}

      {/* Deliberately no transcript here at all, saved-meeting view or freshly completed - only translation and
          summary are ever shown; the transcript stays a backend/database-only record (see lib/meetingApi.js /
          MeetingStatusResponse and MeetingDetail on the backend, neither of which even returns it). */}
      {phase === 'completed' && result && (
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
          {meetingId
            ? <button type="button" className="meeting-secondary" onClick={onClose}>Close</button>
            : <button type="button" className="meeting-secondary" onClick={startOver}>Start another meeting</button>}
        </div>
      )}
    </section>
  );
}
