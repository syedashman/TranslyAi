// Live Meeting audio capture. ONE pipeline, two sources mixed in the browser:
//
//   shared meeting tab audio  (getDisplayMedia -> its AUDIO track: what the tab PLAYS - the other participants)
//   + host microphone         (getUserMedia: what the host SAYS - never part of the tab's audio)
//        -> Web Audio: per-source gain -> mixer -> limiter -> PCM worklet (mono, 16 kHz, PCM16 chunks)
//        -> onChunk() -> the ONE WebSocket to the server -> the ONE existing STT stream.
//
// Why the mic must be added explicitly: a shared tab's audio track only contains what that tab plays out of the
// speakers. In a Google Meet the remote participants are played by the tab, but the host's own voice never is - it
// only goes to the microphone - so tab-only capture silently drops everything the host says.
//
// Nothing is accumulated: each chunk is handed to onChunk and released, so a multi-hour meeting uses constant
// memory. The video track is never read, encoded or uploaded (it is only kept alive because ending it ends the
// whole share in most browsers). The mixed audio graph ends in a ZERO-gain sink, so it is never played back through
// the speakers (no echo / feedback loop); the microphone is opened exactly once and only ever feeds this graph.
//
// The user chooses what to share in the browser's native dialog - this never tries to bypass it, and it does not
// integrate with Zoom/Meet/Discord/etc.: it captures whatever tab/window audio the user explicitly shares.

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 4000; // 250 ms per chunk = 8000 bytes
const TAB_GAIN = 0.9;
const MIC_GAIN = 1.0;

export class CaptureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Runs on the audio rendering thread: downmix to mono, average-decimate to 16 kHz, emit fixed-size Int16 chunks.
const WORKLET_SOURCE = `
class PcmChunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetRate, chunkSamples } = options.processorOptions;
    this.ratio = sampleRate / targetRate;
    this.chunkSamples = chunkSamples;
    this.out = new Int16Array(chunkSamples);
    this.o = 0; this.phase = 0; this.acc = 0; this.count = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      this.acc += s / channels; this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.count));
        this.acc = 0; this.count = 0;
        this.out[this.o++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.o === this.chunkSamples) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(this.chunkSamples);
          this.o = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-chunker', PcmChunker);
`;

const UNSUPPORTED_MESSAGE = "This browser can't capture meeting audio. Please use Chrome or Edge on a computer and share a browser tab with audio.";

function describeShareError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
    return new CaptureError('cancelled', 'Meeting audio sharing was cancelled.');
  }
  if (error?.name === 'NotSupportedError' || error?.name === 'TypeError' || error?.name === 'NotFoundError') {
    return new CaptureError('unsupported', UNSUPPORTED_MESSAGE);
  }
  return new CaptureError('failed', 'Could not start meeting audio sharing. Please try again.');
}

function describeMicError(error) {
  const name = error?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new CaptureError('mic_denied', "Microphone access was blocked. TranslyAI needs your microphone so that YOUR OWN speech is translated too - without it only the meeting tab's audio (the other participants) is captured. Allow the microphone for this site in your browser's address bar, then try again.");
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new CaptureError('mic_missing', "No microphone was found. Connect a microphone and try again - it is needed so that your own speech is translated too.");
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new CaptureError('mic_busy', 'Your microphone is being used by another app or could not be opened. Close the other app (or pick a different microphone) and try again.');
  }
  return new CaptureError('mic_failed', 'Could not open your microphone. Please try again.');
}

export function isLiveCaptureSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof window !== 'undefined' && typeof window.AudioContext === 'function' && typeof AudioWorkletNode === 'function';
}

const stopTracks = (stream) => stream?.getTracks().forEach((track) => { track.onended = null; track.onmute = null; track.onunmute = null; try { track.stop(); } catch { /* already stopped */ } });

// Options:
//   onChunk(ArrayBuffer of PCM16)      ~4x/second, the MIXED microphone + meeting audio.
//   onEnded(reason)                    once, if capture can no longer continue by itself: 'share' (the user clicked the
//                                      browser's "Stop sharing" / closed the shared tab) or 'mic' (microphone-only capture lost its mic).
//   onSourceChange(name, state)        name 'mic' | 'tab'; state 'ok' | 'muted' | 'lost'. Informational: capture continues.
//   micOptional                        true = if the microphone cannot be opened, continue with the meeting audio only
//                                      (the caller decided this explicitly, after showing the reason).
// Resolves { stop(), sources: { mic: boolean, tab: boolean } } - which sources are really connected.
export async function startLiveAudioCapture({ onChunk, onEnded, onSourceChange, micOptional = false }) {
  if (!isLiveCaptureSupported()) throw new CaptureError('unsupported', UNSUPPORTED_MESSAGE);

  // 1. The share dialog FIRST: it needs the click that started this (a permission prompt before it could use it up).
  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
  } catch (error) {
    throw describeShareError(error);
  }
  const tabTracks = displayStream.getAudioTracks();

  // 2. The host's own microphone, requested once. Echo cancellation is on so the meeting audio coming out of the
  //    host's speakers is not picked up a second time by the mic (the browser knows what it is playing).
  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
  } catch (error) {
    if (!micOptional) {
      stopTracks(displayStream);
      throw describeMicError(error);
    }
  }

  if (!tabTracks.length && !micStream) {
    stopTracks(displayStream);
    throw new CaptureError('no_audio', 'No meeting audio was detected. Please share a browser tab or window with audio.');
  }
  if (tabTracks.length) {
    // The picture is never used - stop it being rendered/encoded, but keep the track so the share stays alive.
    displayStream.getVideoTracks().forEach((track) => { track.enabled = false; });
  } else {
    // "Share tab audio" was not ticked: the share carries nothing useful, so release it. The microphone alone goes on
    // and the caller is told (sources.tab === false) so the host knows the other participants are NOT captured.
    stopTracks(displayStream);
    displayStream = null;
  }

  let context = null;
  let node = null;
  let stopped = false;
  let paused = false;
  let endedNotified = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { if (node?.port) node.port.onmessage = null; node?.disconnect(); } catch { /* already disconnected */ }
    stopTracks(displayStream);
    stopTracks(micStream);
    if (context) { context.onstatechange = null; context.close().catch(() => {}); }
  };
  const notifyEnded = (reason) => {
    if (stopped || endedNotified) return;
    endedNotified = true;
    onEnded?.(reason);
  };

  try {
    context = new AudioContext();
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try { await context.audioWorklet.addModule(workletUrl); } finally { URL.revokeObjectURL(workletUrl); }
    if (context.state === 'suspended') await context.resume();

    node = new AudioWorkletNode(context, 'pcm-chunker', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { targetRate: TARGET_SAMPLE_RATE, chunkSamples: CHUNK_SAMPLES },
    });
    node.port.onmessage = (event) => { if (!stopped && !paused) onChunk(event.data); };

    // Both sources are summed into ONE mixer (Web Audio adds everything connected to a node's input), then a
    // limiter keeps two loud sources from clipping. The single mixed stream is what the STT hears.
    const mixer = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.1;
    if (tabTracks.length) {
      const tabGain = context.createGain();
      tabGain.gain.value = TAB_GAIN;
      context.createMediaStreamSource(new MediaStream(tabTracks)).connect(tabGain);
      tabGain.connect(mixer);
    }
    if (micStream) {
      const micGain = context.createGain();
      micGain.gain.value = MIC_GAIN;
      context.createMediaStreamSource(micStream).connect(micGain);
      micGain.connect(mixer);
    }
    mixer.connect(limiter);
    limiter.connect(node);
    // Some browsers only run a worklet that is connected onward; a zero-gain sink keeps it running silently. The
    // mixed audio is NEVER audible locally: no playback, so no echo and no feedback loop is possible.
    const mute = context.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(context.destination);

    // A backgrounded tab / OS audio change can suspend the context; capture must not silently go quiet.
    context.onstatechange = () => {
      if (!stopped && (context.state === 'suspended' || context.state === 'interrupted')) context.resume().catch(() => {});
    };
  } catch (error) {
    stop();
    console.warn('[TranslyAI] live capture setup failed:', error);
    throw new CaptureError('failed', 'Could not start meeting audio sharing. Please try again.');
  }

  // Source lifecycle. Tab share ended by the user/browser or the meeting tab closing -> the meeting audio is gone, so
  // the meeting is finished. A microphone that disappears (unplugged, permission revoked) only warns while the tab
  // audio still flows; if it was the only source, the meeting is finished.
  displayStream?.getTracks().forEach((track) => { track.onended = () => notifyEnded('share'); });
  micStream?.getAudioTracks().forEach((track) => {
    track.onended = () => {
      if (stopped) return;
      onSourceChange?.('mic', 'lost');
      if (!tabTracks.length) notifyEnded('mic');
    };
    track.onmute = () => { if (!stopped) onSourceChange?.('mic', 'muted'); };
    track.onunmute = () => { if (!stopped) onSourceChange?.('mic', 'ok'); };
  });

  // Pause keeps every stream, the audio graph and the share alive (resuming must not need the browser's share dialog
  // again): audio is simply not forwarded, and the tracks are disabled so they carry silence meanwhile.
  const setPaused = (value) => {
    if (stopped) return;
    paused = Boolean(value);
    [...tabTracks, ...(micStream?.getAudioTracks() || [])].forEach((track) => { track.enabled = !paused; });
  };

  return { stop, setPaused, sources: { mic: Boolean(micStream), tab: tabTracks.length > 0 } };
}
