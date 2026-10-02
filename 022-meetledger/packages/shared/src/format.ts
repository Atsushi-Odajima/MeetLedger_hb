// Time / timestamp helpers shared by UI and exporters.

export function msToClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}

/** SRT uses comma before milliseconds, VTT uses a dot. */
export function msToSubtitle(ms: number, kind: 'srt' | 'vtt'): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const f = t % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}${kind === 'srt' ? ',' : '.'}${pad(f, 3)}`;
}

/** Parses "HH:MM:SS,mmm" / "HH:MM:SS.mmm" / "MM:SS.mmm" into ms. Returns NaN when invalid. */
export function subtitleToMs(s: string): number {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = Number(m[1] ?? 0);
  const mi = Number(m[2]);
  const se = Number(m[3]);
  const f = Number((m[4] ?? '0').padEnd(3, '0'));
  return ((h * 60 + mi) * 60 + se) * 1000 + f;
}

/** YYYY-MM-DD for a Date in the given IANA timezone. */
export function dateInTz(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes since midnight in the given IANA timezone. */
export function minutesInTz(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}
