import { useEffect, useRef } from 'react';
import { Check, LoaderCircle, Plus, X } from 'lucide-react';

const DOT_GAP = 7;
const DOT_RADIUS = 1.7;
const MAX_BAR = 26;
const STEP_MS = 45;

// Inline voice input bar: a capsule with a live dotted waveform driven by the microphone level.
export default function VoiceBar({ stream, transcribing = false, onCancel, onConfirm }) {
  const canvasRef = useRef(null);
  const handlers = useRef({ onCancel, onConfirm });
  handlers.current = { onCancel, onConfirm };

  // Escape cancels, Enter confirms. preventDefault keeps a focused button from also firing its own click.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); handlers.current.onCancel(); }
      else if (event.key === 'Enter') { event.preventDefault(); handlers.current.onConfirm(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    let audioContext = null;
    let analyser = null;
    let samples = null;
    let history = [];
    let columns = 0;
    let level = 0;
    let lastStep = 0;
    let frame = 0;

    if (AudioContextClass && stream) {
      try {
        audioContext = new AudioContextClass();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        samples = new Uint8Array(analyser.fftSize);
        audioContext.resume?.();
      } catch { analyser = null; }
    }

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const { clientWidth, clientHeight } = canvas;
      canvas.width = Math.max(1, Math.round(clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(clientHeight * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      columns = Math.max(1, Math.floor(clientWidth / DOT_GAP));
      history = history.slice(-columns);
      while (history.length < columns) history.unshift(0);
    };

    const readLevel = () => {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) { const v = (samples[i] - 128) / 128; sum += v * v; }
      return Math.min(1, Math.sqrt(sum / samples.length) * 5);
    };

    const draw = (now) => {
      // Rise quickly with the voice and fall slowly so the line looks smooth.
      const target = readLevel();
      level = target > level ? target : level * 0.85 + target * 0.15;
      if (now - lastStep >= STEP_MS) { history.push(level); history.shift(); lastStep = now; }

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = ctx.strokeStyle = getComputedStyle(canvas).color;
      ctx.lineCap = 'round';
      ctx.lineWidth = DOT_RADIUS * 2;
      const mid = height / 2;
      const offset = (width - (columns - 1) * DOT_GAP) / 2;
      for (let i = 0; i < columns; i += 1) {
        const x = offset + i * DOT_GAP;
        const half = (history[i] * MAX_BAR) / 2;
        if (half < 0.5) { ctx.beginPath(); ctx.arc(x, mid, DOT_RADIUS, 0, Math.PI * 2); ctx.fill(); }
        else { ctx.beginPath(); ctx.moveTo(x, mid - half); ctx.lineTo(x, mid + half); ctx.stroke(); }
      }
      frame = requestAnimationFrame(draw);
    };

    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      audioContext?.close?.().catch(() => {});
    };
  }, [stream]);

  return (
    <div className="voice-bar" role="group" aria-label="Voice input">
      <button type="button" className="voice-icon" disabled aria-label="Add" title="Add"><Plus size={20} /></button>
      <canvas ref={canvasRef} className="voice-wave" aria-hidden="true" />
      <button type="button" className="voice-icon" onClick={onCancel} aria-label={transcribing ? 'Cancel transcription' : 'Cancel recording'} title="Cancel (Esc)"><X size={20} /></button>
      <button type="button" className="voice-confirm" onClick={onConfirm} disabled={transcribing} aria-label={transcribing ? 'Transcribing' : 'Transcribe recording'} title={transcribing ? 'Transcribing...' : 'Done (Enter)'}>{transcribing ? <LoaderCircle size={20} className="spin" /> : <Check size={20} strokeWidth={2.6} />}</button>
    </div>
  );
}
