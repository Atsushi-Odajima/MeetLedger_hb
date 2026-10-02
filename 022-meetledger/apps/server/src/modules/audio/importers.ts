import { subtitleToMs } from '@meetledger/shared';
import { badRequest } from '../../lib/errors';
import type { InSegment } from './normalize';

// Transcript import parsers (srt / vtt / txt / json). "Name: text" prefixes become speaker labels (names typed by the
// user in their file — not identified from voice). Lines without a prefix continue the previous speaker.

export type ImportFormat = 'srt' | 'vtt' | 'txt' | 'json';

const NAME_PREFIX = /^([^:：\s][^:：]{0,39}?)\s*[:：]\s*(\S.*)$/su;

/** Splits "Name: text". Rejects things that look like times ("10:00"), URLs or long sentences. */
export function splitSpeakerPrefix(line: string): { speaker: string | null; text: string } {
  const m = NAME_PREFIX.exec(line.trim());
  if (!m) return { speaker: null, text: line.trim() };
  const name = m[1].trim();
  // "10:00" style times inside a sentence are not speaker prefixes.
  if (/\d$/.test(name) && /^\d/.test(m[2])) return { speaker: null, text: line.trim() };
  if (/^\d+$/.test(name) || /\/\//.test(line.slice(0, name.length + 3)) || /[。、.!?！？]/.test(name) || name.split(/\s+/).length > 4) return { speaker: null, text: line.trim() };
  return { speaker: name, text: m[2].trim() };
}

function joinLines(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .reduce((acc, l) => (!acc ? l : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー。、]$/u.test(acc) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(l) ? acc + l : `${acc} ${l}`), '');
}

const TIME_LINE = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)/;

function inheritSpeakers(segs: InSegment[]): InSegment[] {
  let prev: string | null = null;
  for (const s of segs) {
    if (s.speaker) prev = s.speaker;
    else if (prev) s.speaker = prev;
  }
  return segs;
}

export function parseSrt(content: string): InSegment[] {
  const out: InSegment[] = [];
  const blocks = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => TIME_LINE.test(l));
    if (ti < 0) continue;
    const m = TIME_LINE.exec(lines[ti])!;
    const start = subtitleToMs(m[1]);
    const end = subtitleToMs(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const text = joinLines(lines.slice(ti + 1).map((l) => l.replace(/<[^>]+>/g, '')));
    const sp = splitSpeakerPrefix(text);
    out.push({ startMs: start, endMs: end, text: sp.text, speaker: sp.speaker });
  }
  return inheritSpeakers(out);
}

export function parseVtt(content: string): InSegment[] {
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!/^WEBVTT/.test(text.trimStart())) throw badRequest('VTT must start with WEBVTT');
  const out: InSegment[] = [];
  for (const b of text.split(/\n{2,}/)) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const ti = lines.findIndex((l) => TIME_LINE.test(l));
    if (ti < 0) continue;
    const m = TIME_LINE.exec(lines[ti])!;
    const start = subtitleToMs(m[1]);
    const end = subtitleToMs(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const body = lines.slice(ti + 1).join('\n');
    const voice = /<v(?:\.[^\s>]+)?\s+([^>]+)>/.exec(body)?.[1]?.trim() ?? null;
    const plain = joinLines(body.split('\n').map((l) => l.replace(/<[^>]+>/g, '')));
    const sp = voice ? { speaker: voice.slice(0, 100), text: plain } : splitSpeakerPrefix(plain);
    out.push({ startMs: start, endMs: end, text: sp.text, speaker: sp.speaker });
  }
  return inheritSpeakers(out);
}

const TXT_TIME = /^\[?((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s+(.*)$/;

/** Plain text: one utterance per line, optional leading "[hh:mm:ss]" and "Name:" prefix. */
export function parseTxt(content: string): InSegment[] {
  const out: InSegment[] = [];
  let lastStart = 0;
  for (const raw of content.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    let start: number | null = null;
    const tm = TXT_TIME.exec(line);
    if (tm) {
      const ms = subtitleToMs(tm[1]);
      if (Number.isFinite(ms)) {
        start = ms;
        line = tm[2].trim();
      }
    }
    const sp = splitSpeakerPrefix(line);
    // Untimed lines keep their position after the previous timed line (flagged, never given invented times).
    const at = start ?? lastStart;
    if (start !== null) lastStart = start;
    out.push({ startMs: at, endMs: at, text: sp.text, speaker: sp.speaker, flags: start === null ? ['no_timestamp'] : [] });
  }
  // Timed lines end where the next one starts (last one: +5 s; marked as estimated).
  for (let i = 0; i < out.length; i++) {
    if (out[i].flags?.includes('no_timestamp')) continue;
    const next = out.slice(i + 1).find((s) => !s.flags?.includes('no_timestamp'));
    if (next && next.startMs > out[i].startMs) out[i].endMs = next.startMs;
    else {
      out[i].endMs = out[i].startMs + 5000;
      out[i].flags = [...(out[i].flags ?? []), 'estimated_end'];
    }
  }
  return inheritSpeakers(out);
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * JSON: `{segments:[...]}` or `[...]`. Each item: {startMs,endMs,text,speaker?,confidence?} (ms) or
 * {start,end,text,speaker?} (seconds, e.g. OpenAI verbose/diarized json).
 */
export function parseJson(content: string): InSegment[] {
  let j: any;
  try {
    j = JSON.parse(content);
  } catch {
    throw badRequest('Invalid JSON transcript');
  }
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.segments) ? j.segments : [];
  if (!list.length) throw badRequest('JSON transcript has no segments');
  const out: InSegment[] = [];
  for (const s of list.slice(0, 50_000)) {
    if (!s || typeof s !== 'object') continue;
    const textRaw = typeof s.text === 'string' ? s.text : typeof s.transcript === 'string' ? s.transcript : '';
    let start = num(s.startMs);
    let end = num(s.endMs);
    if (start === null) {
      const sec = num(s.start);
      start = sec === null ? null : Math.round(sec * 1000);
      const esec = num(s.end);
      end = esec === null ? null : Math.round(esec * 1000);
    }
    const speakerField = typeof s.speaker === 'string' || typeof s.speaker === 'number' ? String(s.speaker).slice(0, 100) : null;
    const sp = speakerField ? { speaker: speakerField, text: textRaw } : splitSpeakerPrefix(textRaw);
    const conf = num(s.confidence);
    out.push({
      startMs: start ?? 0,
      endMs: end ?? start ?? 0,
      text: sp.text,
      speaker: sp.speaker,
      confidence: conf,
      flags: start === null ? ['no_timestamp'] : [],
    });
  }
  return inheritSpeakers(out);
}

export function parseTranscriptImport(format: ImportFormat, content: string): InSegment[] {
  const segs = format === 'srt' ? parseSrt(content) : format === 'vtt' ? parseVtt(content) : format === 'txt' ? parseTxt(content) : parseJson(content);
  if (!segs.length) throw badRequest('No transcript segments found in the imported content');
  return segs;
}
