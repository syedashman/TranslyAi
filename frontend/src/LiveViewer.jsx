import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Check, CircleAlert, LoaderCircle, Users } from 'lucide-react';
import AuthPage from './AuthPage';
import BrandMark from './BrandMark';
import StructuredSummary from './StructuredSummary';
import { formatDuration } from './lib/duration';
import {
  claimLiveMeeting, clearPendingClaim, LiveViewerSocket, readPendingClaim, savePendingClaim,
} from './lib/liveMeetingApi';
import { useSmartScroll } from './lib/smartScroll';
import { supabase } from './lib/supabase';

const STAGE_TEXT = {
  waiting: 'Waiting for the host to start the meeting...',
  paused: 'Meeting paused - the host will resume shortly.',
  host_disconnected: 'The host lost connection - waiting for them to come back...',
  finalizing: 'Meeting ended - finishing the last sentences...',
  translating: 'Meeting ended - translating...',
  summarizing: 'Meeting ended - generating the summary...',
};

// The page a shared link opens (?live=<share token>): a clean, read-only live view for ANYONE - guests need no
// account. It has no sidebar, no chats, no recording or audio-sharing code path and never asks for microphone or
// screen permission: the only thing it can do is receive events. It renders standalone (see main.jsx), so none of
// the host's private Meeting Chats or Translation chats are even loaded here.
export default function LiveViewer({ shareToken }) {
  const [phase, setPhase] = useState('connecting'); // connecting | live | ended | failed | cancelled | unavailable
  const [unavailableReason, setUnavailableReason] = useState('');
  const [stage, setStage] = useState('waiting');
  const [segments, setSegments] = useState([]); // { id, text (Roman Urdu), translation }
  const [partial, setPartial] = useState('');
  const [partialPending, setPartialPending] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [connection, setConnection] = useState('connecting');
  const [notice, setNotice] = useState('');
  const [final, setFinal] = useState(null); // { segments, summary, claim_token, duration_seconds }
  const [user, setUser] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [claim, setClaim] = useState({ status: 'idle', message: '' }); // idle | saving | saved | error

  const endRef = useRef(null);
  const startedAtRef = useRef(0);
  const stageRef = useRef('waiting');
  const pausedAtRef = useRef(null);
  const finalRef = useRef(null);
  finalRef.current = final;

  const translatedCount = segments.reduce((count, segment) => count + (segment.translation ? 1 : 0), 0);
  const { showJump, jumpToLatest } = useSmartScroll(endRef, `${segments.length}:${translatedCount}:${partial}:${partialPending}`, phase === 'live');

  // Who is looking, if anyone: only used to decide what the end-of-meeting "save" call to action says. Signing in
  // grants nothing extra here - a logged-in participant sees exactly what a guest sees.
  useEffect(() => {
    if (!supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => subscription.unsubscribe();
  }, []);

  const applyEvent = (event) => {
    switch (event.type) {
      case 'ready':
        setStage(event.stage || 'waiting');
        setViewerCount(event.viewer_count || 0);
        setPartial(event.partial || ''); setPartialPending(false);
        // The server's copy replaces the list on every (re)connect, so a reconnect can never duplicate entries.
        setSegments((event.segments || []).map((s) => ({ id: s.segment_id, text: s.text, translation: s.translation })));
        startedAtRef.current = Date.now() - (event.elapsed_seconds || 0) * 1000;
        stageRef.current = event.stage || 'waiting';
        pausedAtRef.current = event.stage === 'paused' ? Date.now() : null;
        if (event.outcome === 'completed' && event.final) { setFinal(event.final); setPhase('ended'); }
        else if (event.outcome === 'failed') setPhase('failed');
        else if (event.outcome === 'cancelled') { setSegments([]); setPhase('cancelled'); }
        else setPhase('live');
        break;
      case 'status':
        if (event.stage === 'live' && stageRef.current === 'waiting') startedAtRef.current = Date.now(); // the host just started
        if (event.stage === 'paused' && stageRef.current !== 'paused') pausedAtRef.current = Date.now();
        if (event.stage === 'live' && stageRef.current === 'paused' && pausedAtRef.current) { startedAtRef.current += Date.now() - pausedAtRef.current; pausedAtRef.current = null; } // the timer skips the pause
        stageRef.current = event.stage;
        setStage(event.stage);
        if (event.stage === 'live') setNotice('');
        break;
      case 'viewer_count': setViewerCount(event.count || 0); break;
      case 'transcript_partial': setPartial(event.text || ''); setPartialPending(Boolean(event.pending)); break;
      case 'transcript_final':
        setPartial(''); setPartialPending(false);
        setSegments((current) => (current.some((s) => s.id === event.segment_id) ? current : [...current, { id: event.segment_id, text: event.text, translation: null }]));
        break;
      case 'translation':
        setSegments((current) => current.map((s) => (s.id === event.segment_id ? { ...s, translation: event.text } : s)));
        break;
      case 'error': if (event.fatal) setNotice(event.message || 'The live meeting had a problem and was stopped.'); break;
      case 'completed': setFinal(event.final); setPhase('ended'); break;
      case 'failed': setPhase('failed'); break;
      case 'cancelled': setSegments([]); setPartial(''); setPartialPending(false); setPhase('cancelled'); break; // the host discarded it: nothing of it is kept here either
      default: break;
    }
  };
  const applyEventRef = useRef(applyEvent);
  applyEventRef.current = applyEvent;

  useEffect(() => {
    const socket = new LiveViewerSocket(shareToken, {
      onEvent: (event) => applyEventRef.current(event),
      onStatus: setConnection,
      onUnavailable: (reason) => { setUnavailableReason(reason || ''); setPhase('unavailable'); },
    });
    socket.connect();
    return () => socket.close();
  }, [shareToken]);

  useEffect(() => {
    if (phase !== 'live' || stage !== 'live') return undefined;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase, stage]);

  const runClaim = async (claimToken) => {
    setClaim({ status: 'saving', message: '' });
    try {
      const result = await claimLiveMeeting(claimToken);
      clearPendingClaim();
      setClaim({ status: 'saved', message: result.already_saved ? 'This meeting is already saved in your account.' : 'Saved! This meeting is now in your Meetings.' });
    } catch (error) {
      setClaim({ status: 'error', message: error.message });
    }
  };

  // Guest signed up / logged in right here on the page -> finish the save they asked for, automatically.
  useEffect(() => {
    if (user && final?.claim_token && authOpen) { setAuthOpen(false); runClaim(final.claim_token); }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMeeting = () => {
    if (!final?.claim_token) return;
    if (user) { runClaim(final.claim_token); return; }
    // Kept in this browser so it survives the signup/confirmation/OAuth redirect; the main app finishes the save.
    savePendingClaim(final.claim_token);
    setAuthOpen(true);
  };

  const goToApp = () => { window.location.href = window.location.pathname; };

  if (phase === 'unavailable') {
    return (
      <div className="live-viewer-page">
        <div className="live-viewer-inner live-viewer-center">
          <div className="live-viewer-brand"><BrandMark /><span>TranslyAI</span></div>
          <CircleAlert size={26} />
          <h1>{unavailableReason === 'full' ? 'This live meeting is full.' : 'This live meeting is no longer available.'}</h1>
          <button type="button" className="meeting-secondary" onClick={goToApp}>Go to TranslyAI</button>
        </div>
      </div>
    );
  }

  const isLive = phase === 'live' && stage !== 'finalizing' && stage !== 'translating' && stage !== 'summarizing';
  const statusLine = phase === 'live' ? STAGE_TEXT[stage] : '';

  return (
    <div className="live-viewer-page">
      <div className="live-viewer-inner">
        <header className="live-viewer-head">
          <div className="live-viewer-brand"><BrandMark /><span>TranslyAI</span></div>
          <div className="live-head-right">
            {viewerCount > 0 && phase !== 'ended' && <span className="live-viewers"><Users size={14} />{viewerCount} {viewerCount === 1 ? 'viewer' : 'viewers'}</span>}
          </div>
        </header>

        <div className="live-head">
          <span className={`live-badge ${isLive ? 'is-live' : ''}`}><span className="live-dot" aria-hidden="true" />{phase === 'ended' ? 'MEETING ENDED' : phase === 'cancelled' ? 'MEETING CANCELLED' : stage === 'paused' ? 'MEETING PAUSED' : 'LIVE MEETING'}</span>
          {phase === 'live' && stage === 'live' && <span className="meeting-timer live-timer">{formatDuration(elapsed)}</span>}
        </div>
        {connection === 'reconnecting' && phase !== 'ended' && <p className="live-notice"><LoaderCircle size={13} className="spin" />Connection lost - reconnecting...</p>}
        {statusLine && <p className="live-notice">{statusLine}</p>}
        {notice && <p className="live-notice"><CircleAlert size={13} />{notice}</p>}
        {phase === 'connecting' && <div className="meeting-processing"><LoaderCircle size={26} className="spin" /><p className="meeting-stage">Joining live meeting...</p></div>}
        {phase === 'failed' && (
          <div className="meeting-error"><CircleAlert size={22} /><p>This live meeting ended unexpectedly.</p></div>
        )}
        {phase === 'cancelled' && (
          <div className="meeting-error"><CircleAlert size={22} /><p>The host cancelled this meeting. It was not saved.</p></div>
        )}

        {(phase === 'live' || (phase === 'failed' && segments.length > 0)) && (
          <div className="live-timeline">
            {segments.length === 0 && !partial && !partialPending && stage === 'live' && <p className="meeting-hint live-waiting">Listening for speech...</p>}
            {segments.map((segment) => (
              <div className="live-segment" key={segment.id} data-segment-id={segment.id}>
                <div className="live-label">Speaker</div>
                {segment.text ? <p className="live-text">{segment.text}</p> : <p className="live-text live-pending">(speech text unavailable)</p>}
                <div className="live-label">Translation</div>
                {segment.translation ? <p className="live-text live-translation">{segment.translation}</p> : <p className="live-text live-pending">Translating...</p>}
              </div>
            ))}
            {(partial || partialPending) && phase === 'live' && stage === 'live' && (
              <div className="live-segment live-partial">
                <div className="live-label">Speaker</div>
                <p className="live-text">{partial || <span className="live-typing" aria-label="Listening"><span /><span /><span /></span>}</p>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}

        {phase === 'ended' && final && (
          <div className="live-final">
            <div className="translation-card">
              <div className="result-heading"><span>Translation</span></div>
              {final.segments.map((segment) => <p key={segment.segment_id}>{segment.translation}</p>)}
            </div>
            <div className="summary-card">
              <div className="summary-heading"><Users size={14} />Meeting summary</div>
              <StructuredSummary text={final.summary} />
            </div>

            {final.claim_token && (
              <div className="live-save-card">
                {claim.status === 'saved' ? (
                  <>
                    <p className="live-save-title"><Check size={16} />{claim.message}</p>
                    <button type="button" className="meeting-start-button" onClick={goToApp}>Open TranslyAI</button>
                  </>
                ) : (
                  <>
                    <p className="live-save-title">{user ? 'Save this meeting to your account' : 'Sign up to save your meeting'}</p>
                    <p className="live-save-text">{user
                      ? 'Add a copy of this meeting to your TranslyAI account so you can find it later.'
                      : 'Create a free TranslyAI account to save this meeting and access it later.'}</p>
                    {claim.status === 'error' && <p className="meeting-error-line"><CircleAlert size={14} />{claim.message}</p>}
                    <button type="button" className="meeting-start-button" onClick={saveMeeting} disabled={claim.status === 'saving'}>
                      {claim.status === 'saving' ? <LoaderCircle size={15} className="spin" /> : user ? 'Save meeting' : 'Sign up to save your meeting'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {showJump && <button type="button" className="live-jump live-jump-viewer" onClick={jumpToLatest}><ArrowDown size={14} />Jump to latest</button>}
      </div>

      {authOpen && (
        <div className="auth-overlay" role="dialog" aria-modal="true" aria-label="Sign up">
          <AuthPage key="viewer-signup" initialMode="signup" onBack={() => setAuthOpen(false)} />
        </div>
      )}
    </div>
  );
}
