// AudioWorklet: taps the ChannelMerger output (ch0 = mic, ch1 = system audio) and streams 16 kHz mono PCM16
// plus a per-100 ms [L,R] RMS envelope to the page, which forwards it to main (written to disk as WAV).
// Runs in AudioWorkletGlobalScope — no DOM. Bundled to recorder/pcm-tap-worklet.js.

import { PcmTapCore } from '../../shared/audio/dsp';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

const FLUSH_SAMPLES = 16_000 / 2; // ~500 ms

class PcmTap extends AudioWorkletProcessor {
  private core = new PcmTapCore(sampleRate);
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'stop') {
        this.flush();
        this.stopped = true;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const input = inputs[0];
    if (input && input.length > 0 && input[0]) {
      this.core.push(input[0], input.length > 1 && input[1] ? input[1] : null);
    }
    if (this.core.bufferedSamples >= FLUSH_SAMPLES) this.flush();
    return true;
  }

  private flush(): void {
    const { pcm, env } = this.core.drain();
    if (pcm.length === 0 && env.length === 0) return;
    this.port.postMessage({ type: 'data', pcm: pcm.buffer, env: env.buffer }, [pcm.buffer, env.buffer]);
  }
}

registerProcessor('meetledger-pcm-tap', PcmTap);
