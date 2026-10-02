import { describe, expect, it } from 'vitest';
import { SPEAKER_REMOTE, SPEAKER_SELF, SPEAKER_UNKNOWN, activeLevel, attributeSpeakers, segmentPower, type Envelope } from '../src/shared/audio/attribution';

/** builds a 100 ms envelope from per-second [mic, system] RMS pairs */
function env(perSecond: [number, number][]): Envelope {
  const frames: number[] = [];
  for (const [l, r] of perSecond) for (let i = 0; i < 10; i++) frames.push(l, r);
  return { frames: Float32Array.from(frames), frameMs: 100 };
}

describe('channel-based speaker attribution', () => {
  // mic is quiet (gain 0.05) vs. digital loopback (0.3): normalization must remove that bias
  const e = env([
    [0.05, 0.0005], // 0-1 s: me
    [0.004, 0.3], // 1-2 s: remote (acoustic echo in mic)
    [0.05, 0.3], // 2-3 s: double talk
    [0.05, 0.0005], // 3-4 s: me
    [0.004, 0.3], // 4-5 s: remote
  ]);
  const segs = [
    { startMs: 0, endMs: 1000, text: 'a', speaker: 'S0' },
    { startMs: 1000, endMs: 2000, text: 'b', speaker: 'S1' },
    { startMs: 2000, endMs: 3000, text: 'c', speaker: 'S1' },
    { startMs: 3000, endMs: 4000, text: 'd' },
    { startMs: 4000, endMs: 5000, text: 'e', speaker: 'S2' },
  ];

  it('labels mic-dominant segments "あなた" and system-dominant ones as the other side', () => {
    const out = attributeSpeakers(segs, e, { systemAudioCaptured: true });
    expect(out.map((s) => s.speaker)).toEqual([SPEAKER_SELF, `${SPEAKER_REMOTE}1`, '話者1', SPEAKER_SELF, `${SPEAKER_REMOTE}2`]);
    expect(out[2]!.text).toBe('c');
  });

  it('ambiguous segments without diarization become 不明', () => {
    const out = attributeSpeakers([{ startMs: 2000, endMs: 3000, text: 'x' }], e, { systemAudioCaptured: true });
    expect(out[0]!.speaker).toBe(SPEAKER_UNKNOWN);
  });

  it('without system audio it never claims "あなた" and keeps neutral diarization labels', () => {
    const out = attributeSpeakers(segs, e, { systemAudioCaptured: false });
    expect(out.map((s) => s.speaker)).toEqual(['話者1', '話者2', '話者2', undefined, '話者3']);
    expect('speaker' in out[3]!).toBe(false);
  });

  it('silent system channel overall → no channel inference', () => {
    const quiet = env([
      [0.05, 0],
      [0.05, 0],
    ]);
    const out = attributeSpeakers([{ startMs: 0, endMs: 1000, text: 'x' }], quiet, { systemAudioCaptured: true });
    expect(out[0]!.speaker).toBeUndefined();
  });

  it('helpers: active level and segment power', () => {
    expect(activeLevel(e.frames, 1)).toBeCloseTo(0.3, 5);
    const p = segmentPower(e, 0, 1000);
    expect(p.frames).toBe(10);
    expect(p.l).toBeCloseTo(0.0025, 6);
    expect(segmentPower(e, 99_000, 99_500).frames).toBe(0);
  });
});
