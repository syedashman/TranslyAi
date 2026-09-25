// Live Meeting audio capture: the browser's own screen/tab-share dialog (getDisplayMedia) -> its AUDIO track only ->
// mono 16 kHz PCM16 chunks, streamed out as they are produced. Nothing is accumulated: each chunk is handed to
// onChunk and released, so a multi-hour meeting uses constant memory. The video track is never read, encoded or
// uploaded (it is only kept alive because ending it ends the whole share in most browsers).
//
// The user chooses what to share in the browser's native dialog - this never tries to bypass it, and it does not
// integrate with Zoom/Meet/Discord/etc.: it captures whatever tab/window audio the user explicitly shares.

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 4000; // 250 ms per chunk = 8000 bytes

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

function describeShareError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
    return new CaptureError('cancelled', 'Meeting audio sharing was cancelled.');
  }
  if (error?.name === 'NotSupportedError' || error?.name === 'TypeError' || error?.name === 'NotFoundError') {
    return new CaptureError('unsupported', "This browser can't capture meeting audio. Please use Chrome or Edge on a computer and share a browser tab with audio.");
  }
  return new CaptureError('failed', 'Could not start meeting audio sharing. Please try again.');
}

export function isLiveCaptureSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
    && typeof window !== 'undefined' && typeof window.AudioContext === 'function' && typeof AudioWorkletNode === 'function';
}

// onChunk(ArrayBuffer of PCM16) is called ~4x/second. onEnded() fires once if the share ends by itself (the user
// clicked the browser's "Stop sharing", or the shared tab was closed). Returns { stop() }.
export async function startTabAudioCapture(onChunk, onEnded) {
  if (!isLiveCaptureSupported()) {
    throw new CaptureError('unsupported', "This browser can't capture meeting audio. Please use Chrome or Edge on a computer and share a browser tab with audio.");
  }

  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
  } catch (error) {
    throw describeShareError(error);
  }

  const audioTracks = displayStream.getAudioTracks();
  if (!audioTracks.length) {
    displayStream.getTracks().forEach((track) => track.stop());
    throw new CaptureError('no_audio', 'No meeting audio was detected. Please share a browser tab or window with audio.');
  }
  // The picture is never used - stop it being rendered/encoded, but keep the track so the share stays alive.
  displayStream.getVideoTracks().forEach((track) => { track.enabled = false; });

  let context = null;
  let node = null;
  let stopped = false;
  let endedNotified = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { node?.port && (node.port.onmessage = null); node?.disconnect(); } catch { /* already disconnected */ }
    displayStream.getTracks().forEach((track) => { track.onended = null; try { track.stop(); } catch { /* already stopped */ } });
    context?.close().catch(() => {});
  };
  const notifyEnded = () => {
    if (stopped || endedNotified) return;
    endedNotified = true;
    onEnded?.();
  };

  try {
    context = new AudioContext();
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try { await context.audioWorklet.addModule(workletUrl); } finally { URL.revokeObjectURL(workletUrl); }
    if (context.state === 'suspended') await context.resume();

    const source = context.createMediaStreamSource(new MediaStream(audioTracks));
    node = new AudioWorkletNode(context, 'pcm-chunker', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { targetRate: TARGET_SAMPLE_RATE, chunkSamples: CHUNK_SAMPLES },
    });
    node.port.onmessage = (event) => { if (!stopped) onChunk(event.data); };
    // Some browsers only run a worklet that is connected onward; a zero-gain sink keeps it running silently, and
    // nothing here ever plays the captured audio back through the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
  } catch (error) {
    stop();
    console.warn('[TranslyAI] live capture setup failed:', error);
    throw new CaptureError('failed', 'Could not start meeting audio sharing. Please try again.');
  }

  displayStream.getTracks().forEach((track) => { track.onended = notifyEnded; });
  return { stop };
}
