import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Check, CircleAlert, Link2, LoaderCircle, Mic, Pause, Play, Radio, Square, Users, X } from 'lucide-react';
import ConfirmDiscardModal from './ConfirmDiscardModal';
import { copyText } from './lib/clipboard';
import { formatDuration } from './lib/duration';
import { describeError } from './lib/errors';
import { buildShareUrl, cancelLiveMeeting, createLiveMeeting, LiveMeetingSocket } from './lib/liveMeetingApi';
import { CaptureError, isLiveCaptureSupported, startLiveAudioCapture } from './lib/liveMeetingCapture';
import { deleteMeetingChat } from './lib/meetingApi';
import { useSmartScroll } from './lib/smartScroll';

// How long to wait for the server to acknowledge Stop before handing over to the normal status polling anyway.
const STOP_ACK_TIMEOUT_MS = 5000;
// Peak level (of 32767) above which a chunk counts as "audio was heard"; below it the capture is effectively silent.
const AUDIO_PEAK_THRESHOLD = 300;
// After this long with no audio at all, the header says what to check instead of waiting silently.
const NO_AUDIO_HINT_SECONDS = 15;

const SOURCE_TEXT = {
  both: { text: 'Microphone + meeting audio connected', warn: false },
  tab: { text: 'Meeting audio connected - no microphone, so your own speech is NOT translated', warn: true },
  mic: { text: "Microphone connected - the meeting tab's audio was not shared, so other participants are NOT translated", warn: true },
};

// Live Meeting: an additional way to start a meeting result inside a Meeting Chat, next to Record Meeting and
// Upload Recording (MeetingChat.jsx renders this in place of its idle controls). The host shares a browser tab
// with audio through the browser's own dialog AND allows the microphone; both are mixed into one stream, sentences
// appear as they are recognised, each followed by its translation. Stop Meeting hands the finished session back to
// MeetingChat via onStopped(jobId, chatId), which then follows the exact same status-polling / result-saving path a
// recording uses. Cancel Meeting DISCARDS instead (nothing saved) and returns via onDiscarded().
export default function LiveMeeting({ chatId, onCancel, onStopped, onDiscarded }) {
  const [phase, setPhase] = useState('setup'); // setup | connecting | live | stopping | cancelling | cancel_failed
  const [segments, setSegments] = useState([]); // { id, text, translation, failed }
  const [partial, setPartial] = useState('');
  const [partialPending, setPartialPending] = useState(false); // speech heard, its Roman Urdu text not ready yet
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [micProblem, setMicProblem] = useState(false); // the last start failed because of the microphone -> offer "continue without"
  const [notice, setNotice] = useState('');
  const [connection, setConnection] = useState('live'); // live | reconnecting
  const [sources, setSources] = useState({ mic: false, tab: false });
  const [micState, setMicState] = useState('ok'); // ok | muted | lost
  const [heardAudio, setHeardAudio] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [paused, setPaused] = useState(false); // the host paused: same session, audio not being sent
  const [shareUrl, setShareUrl] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);

  const captureRef = useRef(null);
  const socketRef = useRef(null);
  const sessionRef = useRef(null); // { id, chatId, createdChat }
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const handedOffRef = useRef(false);
  const stopTimeoutRef = useRef(null);
  const endRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const heardAudioRef = useRef(false);
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;
  const onDiscardedRef = useRef(onDiscarded);
  onDiscardedRef.current = onDiscarded;
  const phaseRef = useRef('setup');
  phaseRef.current = phase;
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  const startTimer = (offsetSeconds = 0) => {
    stopTimer();
    startedAtRef.current = Date.now() - offsetSeconds * 1000;
    setElapsed(offsetSeconds);
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
  };

  const releaseCapture = () => { captureRef.current?.stop(); captureRef.current = null; };

  const handOff = () => {
    if (handedOffRef.current || !sessionRef.current) return;
    handedOffRef.current = true;
    if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
    stopTimer();
    releaseCapture();
    socketRef.current?.close();
    socketRef.current = null;
    onStoppedRef.current(sessionRef.current.id, sessionRef.current.chatId);
  };

  // The meeting was discarded (confirmed by the server): everything local is released and the user is back in the
  // Meeting Chat. A Meeting Chat that THIS attempt created (and that therefore holds nothing) is removed again.
  const finishDiscard = () => {
    if (handedOffRef.current) return;
    handedOffRef.current = true;
    if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
    stopTimer();
    releaseCapture();
    socketRef.current?.close();
    socketRef.current = null;
    if (sessionRef.current?.createdChat) deleteMeetingChat(sessionRef.current.chatId).catch(() => {});
    sessionRef.current = null;
    onDiscardedRef.current?.();
  };

  // Leaving mid-meeting (switching chats, closing the panel): stop capture and ask the server to finish and save
  // what was captured. A page close/reload can't send anything reliably - the server notices the dropped
  // connection and finalizes on its own after its reconnect grace period, so nothing is left running either way.
  useEffect(() => () => {
    stopTimer();
    if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    releaseCapture();
    if (!handedOffRef.current && socketRef.current) {
      if (phaseRef.current === 'live') socketRef.current.sendStop();
      socketRef.current.close();
    }
  }, []);

  // Smart scrolling on the real scroll container (the Meeting Chat panel): follows new sentences only while the
  // reader is at the bottom, never yanks them back after they scroll up, and offers "Jump to latest" instead.
  const translatedCount = segments.reduce((count, segment) => count + (segment.translation ? 1 : 0), 0);
  const { showJump, jumpToLatest } = useSmartScroll(endRef, `${segments.length}:${translatedCount}:${partial}:${partialPending}`, phase === 'live' || phase === 'stopping');

  const applyEvent = (event) => {
    switch (event.type) {
      case 'ready':
        // Also sent on every reconnect: replace the list with the server's copy so nothing is missed or doubled.
        setSegments((event.segments || []).map((s) => ({ id: s.segment_id, text: s.text, translation: s.translation, failed: false })));
        setViewerCount(event.viewer_count || 0);
        if (phaseRef.current === 'live') {
          // Reconnect: the server is the source of truth for paused/running (its clock excludes paused time).
          const serverPaused = Boolean(event.paused);
          if (serverPaused !== pausedRef.current) { captureRef.current?.setPaused(serverPaused); setPaused(serverPaused); }
          if (serverPaused) { stopTimer(); setElapsed(event.elapsed_seconds || 0); }
          else if (event.state === 'active' && event.elapsed_seconds) startTimer(event.elapsed_seconds);
        }
        break;
      case 'transcript_partial':
        setPartial(event.text || '');
        setPartialPending(Boolean(event.pending));
        break;
      case 'viewer_count':
        setViewerCount(event.count || 0);
        break;
      case 'transcript_final':
        setPartial(''); setPartialPending(false);
        setSegments((current) => (current.some((s) => s.id === event.segment_id) ? current
          : [...current, { id: event.segment_id, text: event.text, translation: null, failed: false }]));
        break;
      case 'translation':
        setSegments((current) => current.map((s) => (s.id === event.segment_id ? { ...s, translation: event.text, failed: false } : s)));
        break;
      case 'translation_error':
        setSegments((current) => current.map((s) => (s.id === event.segment_id ? { ...s, failed: true } : s)));
        break;
      case 'error':
        if (event.fatal) { setNotice(event.message); if (phaseRef.current === 'live') beginStopping(false); }
        else setNotice(event.message);
        break;
      case 'stopping':
        break;
      case 'completed':
        if (phaseRef.current !== 'cancelling') handOff();
        break;
      case 'cancelled':
        finishDiscard(); // the server confirmed the discard (this browser asked for it, or it was cancelled elsewhere)
        break;
      case 'failed':
        handedOffRef.current = true; // the server already ended this meeting; there is nothing to poll for
        stopTimer(); releaseCapture(); socketRef.current?.close(); socketRef.current = null;
        setError(event.message || 'The live meeting could not be saved.');
        setPhase('setup');
        break;
      default:
        break;
    }
  };

  // Ends capture and asks the server to finish; the server keeps going (pending sentences, summary, save) on its own
  // even if this page goes away, and MeetingChat follows it through the normal status endpoint.
  const beginStopping = (sendStop = true) => {
    if (phaseRef.current === 'stopping' || phaseRef.current === 'cancelling') return;
    setPhase('stopping');
    stopTimer();
    releaseCapture();
    if (sendStop) socketRef.current?.sendStop();
    stopTimeoutRef.current = setTimeout(handOff, STOP_ACK_TIMEOUT_MS);
  };

  // Cancel Meeting = DISCARD. The microphone / tab capture and audio processing stop immediately; the server is then
  // asked (REST, retried; plus a fast WebSocket message) to drop the session: no STT, no translation, no summary,
  // nothing saved, viewers told. If the meeting turns out to be saved already, it is handed over like a normal stop.
  const discardMeeting = async () => {
    setConfirmCancel(false);
    const session = sessionRef.current;
    if (!session || phaseRef.current === 'cancelling') return;
    if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
    setPhase('cancelling'); setError('');
    stopTimer();
    releaseCapture();
    socketRef.current?.sendCancel();
    try {
      await cancelLiveMeeting(session.id);
    } catch (cancelError) {
      if (cancelError.code === 'already_saved') { setPhase('stopping'); handOff(); return; }
      setError(cancelError.message);
      setPhase('cancel_failed');
      return;
    }
    finishDiscard();
  };

  // Pause Meeting: audio stops being captured/sent, the SAME session stays alive (no finalize, no save, viewers stay
  // connected). Only reflected in the UI once the server has actually been told.
  const pauseMeeting = () => {
    if (phaseRef.current !== 'live' || pausedRef.current) return;
    if (!socketRef.current?.sendPause()) { setNotice("Can't pause right now - the connection is being restored. Try again in a moment."); return; }
    captureRef.current?.setPaused(true);
    stopTimer();
    setPaused(true); setPartial(''); setPartialPending(false);
  };

  const resumeMeeting = () => {
    if (phaseRef.current !== 'live' || !pausedRef.current) return;
    if (!socketRef.current?.sendResume()) { setNotice("Can't resume right now - the connection is being restored. Try again in a moment."); return; }
    captureRef.current?.setPaused(false);
    startTimer(elapsed);
    setPaused(false);
  };

  const copyShareLink = async () => {
    if (!shareUrl) return;
    if (await copyText(shareUrl)) {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  const onChunk = (buffer) => {
    socketRef.current?.sendAudio(buffer);
    if (heardAudioRef.current) return;
    const samples = new Int16Array(buffer);
    for (let i = 0; i < samples.length; i += 8) {
      if (Math.abs(samples[i]) > AUDIO_PEAK_THRESHOLD) { heardAudioRef.current = true; setHeardAudio(true); return; }
    }
  };

  const startLive = async ({ micOptional = false } = {}) => {
    setError(''); setNotice(''); setMicProblem(false);
    if (!isLiveCaptureSupported()) {
      setError("This browser can't capture meeting audio. Please use Chrome or Edge on a computer and share a browser tab with audio.");
      return;
    }
    setPhase('connecting');
    handedOffRef.current = false;
    heardAudioRef.current = false;
    setHeardAudio(false); setMicState('ok'); setPaused(false);
    let capture;
    try {
      // Capture first: cancelling the browser's share dialog must not leave an empty meeting/chat behind.
      capture = await startLiveAudioCapture({
        onChunk,
        micOptional,
        onEnded: (reason) => {
          if (phaseRef.current !== 'live') return;
          setNotice(reason === 'mic' ? 'Your microphone was disconnected. Finishing up...' : 'Meeting audio sharing ended. Finishing up...');
          beginStopping();
        },
        onSourceChange: (name, state) => { if (name === 'mic') setMicState(state); },
      });
    } catch (captureError) {
      setError(captureError instanceof CaptureError ? captureError.message : 'Could not start meeting audio sharing. Please try again.');
      setMicProblem(captureError instanceof CaptureError && captureError.code.startsWith('mic_'));
      setPhase('setup');
      return;
    }
    captureRef.current = capture;
    setSources(capture.sources);

    try {
      const created = await createLiveMeeting(chatId);
      sessionRef.current = { id: created.id, chatId: created.meeting_chat_id, createdChat: !chatId };
      if (created.share_token) setShareUrl(buildShareUrl(created.share_token));
    } catch (createError) {
      releaseCapture();
      setError(createError.message || describeError(createError));
      setPhase('setup');
      return;
    }

    const socket = new LiveMeetingSocket(sessionRef.current.id, {
      onEvent: applyEvent,
      onStatus: (status) => setConnection(status === 'reconnecting' ? 'reconnecting' : 'live'),
      onGiveUp: (message) => {
        // The server keeps the session and finalizes it itself; hand over to status polling to find out how it ended.
        if (phaseRef.current === 'cancelling') return;
        setNotice(`${message} Saving what was captured...`);
        handOff();
      },
    });
    socketRef.current = socket;
    try {
      await socket.connect();
    } catch (connectError) {
      releaseCapture();
      socketRef.current = null;
      setError(connectError.message);
      setPhase('setup');
      // The session never started: remove the brand-new (empty) chat this attempt created, never an existing one.
      if (sessionRef.current?.createdChat) deleteMeetingChat(sessionRef.current.chatId).catch(() => {});
      sessionRef.current = null;
      return;
    }
    setSegments([]); setPartial('');
    startTimer(0);
    setPhase('live');
  };

  if (phase === 'setup') {
    return (
      <div className="meeting-idle live-setup">
        <p>Open your meeting in a browser tab, then share that tab's audio and your microphone with TranslyAI.</p>
        <ol className="live-steps">
          <li>Click <strong>Share meeting audio + microphone</strong>.</li>
          <li>In the browser's dialog choose <strong>Chrome Tab</strong>, pick your meeting tab (for example Google Meet), and tick <strong>Share tab audio</strong>.</li>
          <li>Allow the <strong>microphone</strong> when asked - it is what lets your OWN speech be translated (the shared tab only carries the other participants).</li>
        </ol>
        <p className="live-examples">Tip: use headphones so the meeting audio isn't picked up twice by your microphone. Works with browser-based meetings and audio sources such as Zoom, Google Meet, Discord, Skype and WhatsApp Web. TranslyAI does not connect to these apps - you choose what to share in your browser's own dialog. Only you (the host) send audio; people you share the link with just watch.</p>
        {error && <p className="meeting-error-line"><CircleAlert size={14} />{error}</p>}
        <div className="meeting-controls">
          <button type="button" className="meeting-start-button" onClick={() => startLive()}><Radio size={16} />Share meeting audio + microphone</button>
          {micProblem && <button type="button" className="meeting-secondary" onClick={() => startLive({ micOptional: true })}><Mic size={16} />Continue without microphone</button>}
          <button type="button" className="meeting-secondary" onClick={onCancel}>Back</button>
        </div>
      </div>
    );
  }

  if (phase === 'connecting') {
    return (
      <div className="meeting-processing">
        <LoaderCircle size={28} className="spin" />
        <p className="meeting-stage">Preparing your live meeting...</p>
        <p className="meeting-hint">Choose the meeting tab (and tick "Share tab audio") in your browser's share dialog, then allow the microphone.</p>
      </div>
    );
  }

  if (phase === 'cancelling' || phase === 'cancel_failed') {
    return (
      <div className="meeting-processing">
        {phase === 'cancelling'
          ? <><LoaderCircle size={28} className="spin" /><p className="meeting-stage">Cancelling meeting...</p><p className="meeting-hint">Stopping audio capture and discarding what was captured. Nothing will be saved.</p></>
          : <>
            <CircleAlert size={26} />
            <p className="meeting-error-line">{error}</p>
            <div className="meeting-controls">
              <button type="button" className="meeting-stop-button" onClick={discardMeeting}>Try cancelling again</button>
            </div>
          </>}
      </div>
    );
  }

  // One plain-language status: what TranslyAI is doing right now.
  const hearingSpeech = Boolean(partial) || partialPending;
  const awaitingTranslation = segments.some((segment) => !segment.translation && !segment.failed);
  let status;
  if (phase === 'stopping') status = { label: 'Finalizing', hint: 'Finishing the last sentences, then the translation and summary.' };
  else if (paused) status = { label: 'Meeting Paused', hint: 'Audio is not being captured or translated. Resume when you are ready.' };
  else if (connection === 'reconnecting') status = { label: 'Reconnecting', hint: 'Connection lost - audio is not being sent until it is back.' };
  else if (!heardAudio) status = { label: 'Waiting for audio', hint: elapsed >= NO_AUDIO_HINT_SECONDS ? 'No audio detected yet. Speak, check your microphone, and make sure the meeting tab is playing and you ticked "Share tab audio".' : 'Speak, or play audio in the shared tab.' };
  else if (hearingSpeech) status = { label: 'Listening', hint: '' };
  else if (awaitingTranslation) status = { label: 'Translating', hint: '' };
  else status = { label: 'Listening', hint: '' };
  const sourceLine = sources.mic && sources.tab ? SOURCE_TEXT.both : sources.tab ? SOURCE_TEXT.tab : SOURCE_TEXT.mic;

  return (
    <div className="live-meeting">
      <div className="live-head">
        <span className={`live-badge ${phase === 'live' && !paused ? 'is-live' : ''}`}><span className="live-dot" aria-hidden="true" />{paused ? 'PAUSED' : 'LIVE'}</span>
        <span className="live-head-right">
          {viewerCount > 0 && <span className="live-viewers" title="People watching this live meeting"><Users size={14} />{viewerCount} {viewerCount === 1 ? 'viewer' : 'viewers'}</span>}
          {shareUrl && phase === 'live' && (
            <button type="button" className="meeting-secondary live-share-button" onClick={() => setShareOpen((open) => !open)} aria-expanded={shareOpen}><Link2 size={14} />Share Meeting</button>
          )}
          <span className="meeting-timer live-timer">{formatDuration(elapsed)}</span>
        </span>
      </div>
      <p className="live-status" role="status">
        <strong>{status.label}</strong>
        {status.hint && <span> - {status.hint}</span>}
      </p>
      <p className={`live-source ${sourceLine.warn ? 'is-warn' : ''}`}>
        {sourceLine.warn ? <CircleAlert size={13} /> : <Mic size={13} />}{sourceLine.text}
      </p>
      {micState === 'lost' && <p className="live-notice is-warn"><CircleAlert size={13} />Your microphone was disconnected - your own speech is no longer being translated. Meeting audio is still being captured.</p>}
      {micState === 'muted' && <p className="live-notice is-warn"><CircleAlert size={13} />Your microphone is muted (by the system or another app) - your own speech is not being captured.</p>}
      {shareOpen && shareUrl && (
        <div className="live-share-panel">
          <p>Anyone with this link can watch this meeting live, read-only - no account needed. They can't hear, control or change anything.</p>
          <div className="live-share-row">
            <input type="text" readOnly value={shareUrl} onFocus={(event) => event.target.select()} aria-label="Live meeting share link" />
            <button type="button" className="meeting-start-button live-copy-button" onClick={copyShareLink}>{copied ? <><Check size={14} />Copied</> : 'Copy Link'}</button>
          </div>
        </div>
      )}
      {connection === 'reconnecting' && <p className="live-notice"><LoaderCircle size={13} className="spin" />Connection lost - reconnecting...</p>}
      {notice && <p className="live-notice"><CircleAlert size={13} />{notice}</p>}

      <div className="live-timeline">
        {segments.length === 0 && !partial && !partialPending && <p className="meeting-hint live-waiting">{heardAudio ? 'Listening for speech...' : 'Waiting for audio...'}</p>}
        {segments.map((segment) => (
          <div className="live-segment" key={segment.id} data-segment-id={segment.id}>
            <div className="live-label">Speaker</div>
            {segment.text ? <p className="live-text">{segment.text}</p> : <p className="live-text live-pending">(speech text unavailable)</p>}
            <div className="live-label">Translation</div>
            {segment.translation
              ? <p className="live-text live-translation">{segment.translation}</p>
              : <p className="live-text live-pending">{segment.failed ? 'Translation unavailable - it will be retried when the meeting ends.' : 'Translating...'}</p>}
          </div>
        ))}
        {(partial || partialPending) && phase === 'live' && !paused && (
          <div className="live-segment live-partial">
            <div className="live-label">Speaker</div>
            <p className="live-text">{partial || <span className="live-typing" aria-label="Listening"><span /><span /><span /></span>}</p>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="live-footer">
        {showJump && <button type="button" className="live-jump" onClick={jumpToLatest}><ArrowDown size={14} />Jump to latest</button>}
        {phase === 'stopping'
          ? <div className="live-stopping"><LoaderCircle size={16} className="spin" />Finishing the last sentences...<button type="button" className="meeting-secondary live-cancel-button" onClick={() => setConfirmCancel(true)}><X size={14} />Cancel Meeting</button></div>
          : (
            <div className="live-footer-actions">
              {paused
                ? <button type="button" className="meeting-start-button live-pause-button" onClick={resumeMeeting}><Play size={14} />Resume Meeting</button>
                : <button type="button" className="meeting-secondary live-pause-button" onClick={pauseMeeting} disabled={connection === 'reconnecting'}><Pause size={14} />Pause Meeting</button>}
              <button type="button" className="meeting-stop-button" onClick={() => beginStopping()}><Square size={14} />Stop Meeting</button>
              <button type="button" className="meeting-secondary live-cancel-button" onClick={() => setConfirmCancel(true)}><X size={14} />Cancel Meeting</button>
            </div>
          )}
      </div>

      {confirmCancel && (
        <ConfirmDiscardModal
          title="Cancel this meeting?"
          body="The current meeting will be discarded and won't be saved."
          keepLabel="Keep meeting"
          discardLabel="Cancel meeting"
          onKeep={() => setConfirmCancel(false)}
          onDiscard={discardMeeting}
        />
      )}
    </div>
  );
}
