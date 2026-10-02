// Speaker label normalization. Diarization only separates voices into anonymous clusters ("Speaker 1", "Speaker 2"…);
// it never identifies real people. Names are assigned by humans (speaker mapping) only.

export interface Labeled {
  speaker?: string | null;
}

/**
 * Maps provider labels ("A", "speaker_3", "1"…) to "Speaker N" in order of first appearance.
 * Segments without a label inherit the nearest preceding labeled segment (or the first label when none precedes).
 * Returns the normalized label per segment and the provider-label -> normalized-label map.
 */
export function normalizeSpeakerLabels(segments: Labeled[]): { labels: string[]; map: Map<string, string> } {
  const map = new Map<string, string>();
  for (const s of segments) {
    const k = s.speaker?.toString().trim();
    if (k && !map.has(k)) map.set(k, `Speaker ${map.size + 1}`);
  }
  if (!map.size) return { labels: segments.map(() => 'Speaker 1'), map };
  const first = map.values().next().value as string;
  let prev: string | null = null;
  const labels = segments.map((s) => {
    const k = s.speaker?.toString().trim();
    const l = k ? map.get(k)! : (prev ?? first);
    prev = l;
    return l;
  });
  return { labels, map };
}
