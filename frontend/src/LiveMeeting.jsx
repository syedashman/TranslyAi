import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Check, CircleAlert, Link2, LoaderCircle, Radio, Square, Users } from 'lucide-react';
import { copyText } from './lib/clipboard';
import { formatDuration } from './lib/duration';
import { describeError } from './lib/errors';
import { buildShareUrl, createLiveMeeting, LiveMeetingSocket } from './lib/liveMeetingApi';
import { CaptureError, isLiveCaptureSupported, startTabAudioCapture } from './lib/liveMeetingCapture';
import { deleteMeetingChat } from './lib/meetingApi';
import { useSmartScroll } from './lib/smartScroll';

// How long to wait for the server to acknowledge Stop before handing over to the normal status polling anyway.
const STOP_ACK_TIMEOUT_MS = 5000;

// Live Meeting: an additional way to start a meeting result inside a Meeting Chat, next to Record Meeting and
// Upload Recording (MeetingChat.jsx renders this in place of its idle controls). The user shares a browser tab
// with audio through the browser's own dialog; sentences appear as they are recognised, each followed by its
// translation. Stop Meeting hands the finished session back to MeetingChat via onStopped(jobId, chatId), which
// then follows the exact same status-polling / result-saving path a recording uses - this component never
// touches the results list or the chat sidebar itself.
export default function LiveMeeting({ chatId, onCancel, onStopped }) {
  const [phase, setPhase] = useState('setup'); // setup | connecting | live | stopping
  const [segments, setSegments] = useState([]); // { id, text, translation, failed }
  const [partial, setPartial] = useState('');
  const [partialPending, setPartialPending] = useState(false); // speech heard, its Roman Urdu text not ready yet
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connection, setConnection] = useState('live'); // live | reconnecting
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
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;
  const phaseRef = useRef('setup');
  phaseRef.current = phase;

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
        if (event.state === 'active' && phaseRef.current === 'live' && event.elapsed_seconds) startTimer(event.elapsed_seconds);
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
        handOff();
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
    if (phaseRef.current === 'stopping') return;
    setPhase('stopping');
    stopTimer();
    releaseCapture();
    if (sendStop) socketRef.current?.sendStop();
    stopTimeoutRef.current = setTimeout(handOff, STOP_ACK_TIMEOUT_MS);
  };

  const copyShareLink = async () => {
    if (!shareUrl) return;
    if (await copyText(shareUrl)) {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  const startLive = async () => {
    setError(''); setNotice('');
    if (!isLiveCaptureSupported()) {
      setError("This browser can't capture meeting audio. Please use Chrome or Edge on a computer and share a browser tab with audio.");
      return;
    }
    setPhase('connecting');
    handedOffRef.current = false;
    let capture;
    try {
      // Capture first: cancelling the browser's share dialog must not leave an empty meeting/chat behind.
      capture = await startTabAudioCapture(
        (chunk) => socketRef.current?.sendAudio(chunk),
        () => {
          if (phaseRef.current !== 'live') return;
          setNotice('Meeting audio sharing ended. Finishing up...');
          beginStopping();
        },
      );
    } catch (captureError) {
      setError(captureError instanceof CaptureError ? captureError.message : 'Could not start meeting audio sharing. Please try again.');
      setPhase('setup');
      return;
    }
    captureRef.current = capture;

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
        <p>Open your meeting in a browser tab and share its audio with TranslyAI.</p>
        <p className="live-examples">Works with browser-based meetings and audio sources such as Zoom, Google Meet, Discord, Skype and WhatsApp Web. TranslyAI does not connect to these apps - you choose the tab or window to share in your browser's own dialog, and tick "Share tab audio".</p>
        {error && <p className="meeting-error-line"><CircleAlert size={14} />{error}</p>}
        <div className="meeting-controls">
          <button type="button" className="meeting-start-button" onClick={startLive}><Radio size={16} />Share meeting audio</button>
          <button type="button" className="meeting-secondary" onClick={onCancel}>Back</button>
        </div>
      </div>
    );
  }

  if (phase === 'connecting') {
    return (
      <div className="meeting-processing">
        <LoaderCircle size={28} className="spin" />
        <p className="meeting-stage">Starting live meeting...</p>
        <p className="meeting-hint">Choose the meeting tab in your browser's share dialog.</p>
      </div>
    );
  }

  return (
    <div className="live-meeting">
      <div className="live-head">
        <span className={`live-badge ${phase === 'live' ? 'is-live' : ''}`}><span className="live-dot" aria-hidden="true" />LIVE</span>
        <span className="live-head-right">
          {viewerCount > 0 && <span className="live-viewers" title="People watching this live meeting"><Users size={14} />{viewerCount} {viewerCount === 1 ? 'viewer' : 'viewers'}</span>}
          {shareUrl && phase === 'live' && (
            <button type="button" className="meeting-secondary live-share-button" onClick={() => setShareOpen((open) => !open)} aria-expanded={shareOpen}><Link2 size={14} />Share Meeting</button>
          )}
          <span className="meeting-timer live-timer">{formatDuration(elapsed)}</span>
        </span>
      </div>
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
        {segments.length === 0 && !partial && !partialPending && <p className="meeting-hint live-waiting">Listening for speech...</p>}
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
        {(partial || partialPending) && phase === 'live' && (
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
          ? <div className="live-stopping"><LoaderCircle size={16} className="spin" />Finishing the last sentences...</div>
          : <button type="button" className="meeting-stop-button" onClick={() => beginStopping()}><Square size={14} />Stop Meeting</button>}
      </div>
    </div>
  );
}
