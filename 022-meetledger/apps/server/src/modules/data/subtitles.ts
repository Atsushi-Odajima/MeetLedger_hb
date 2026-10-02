// SRT / WebVTT writers (+ small parsers used to verify that exports re-parse cleanly).
import { msToSubtitle, subtitleToMs } from '@meetledger/shared';

export interface Cue {
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
}

const cleanText = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/-->/g, '→');

export function toSrt(cues: Cue[]): string {
  const out: string[] = [];
  let n = 0;
  for (const c of cues) {
    const text = cleanText(c.text);
    if (!text) continue;
    n++;
    const end = Math.max(c.endMs, c.startMs);
    out.push(`${n}\r\n${msToSubtitle(c.startMs, 'srt')} --> ${msToSubtitle(end, 'srt')}\r\n${c.speaker ? `${cleanText(c.speaker).replace(/\n/g, ' ')}: ` : ''}${text.replace(/\n/g, '\r\n')}\r\n`);
  }
  return out.join('\r\n');
}

const vttEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** WebVTT with voice spans (<v Speaker>) and NOTE metadata lines. */
export function toVtt(cues: Cue[], notes: string[] = []): string {
  const out: string[] = ['WEBVTT', ''];
  const meta = notes.map((n) => n.replace(/-->/g, '→').replace(/\r?\n/g, ' ').trim()).filter(Boolean);
  if (meta.length) out.push('NOTE', ...meta, '');
  let n = 0;
  for (const c of cues) {
    const text = cleanText(c.text);
    if (!text) continue;
    n++;
    const end = Math.max(c.endMs, c.startMs);
    const speaker = c.speaker ? cleanText(c.speaker).replace(/[\n<>&]/g, ' ').trim() : '';
    out.push(String(n), `${msToSubtitle(c.startMs, 'vtt')} --> ${msToSubtitle(end, 'vtt')}`, `${speaker ? `<v ${speaker}>` : ''}${vttEscape(text)}`, '');
  }
  return out.join('\n');
}

function blocks(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.split('\n').filter((l) => l.length > 0))
    .filter((b) => b.length);
}

const TIMING = /^\s*([\d:.,]+)\s+-->\s+([\d:.,]+)/;

export function parseSrt(text: string): Cue[] {
  const out: Cue[] = [];
  for (const b of blocks(text)) {
    const ti = b.findIndex((l) => TIMING.test(l));
    if (ti < 0) continue;
    const m = b[ti].match(TIMING)!;
    let body = b.slice(ti + 1).join('\n');
    let speaker: string | null = null;
    const sm = body.match(/^([^:\n：]{1,80})[:：] ?([\s\S]*)$/);
    if (sm) {
      speaker = sm[1].trim();
      body = sm[2];
    }
    out.push({ startMs: subtitleToMs(m[1]), endMs: subtitleToMs(m[2]), speaker, text: body });
  }
  return out;
}

const vttUnescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parseVtt(text: string): Cue[] {
  const bs = blocks(text);
  if (!bs.length || !/^WEBVTT/.test(bs[0][0])) throw new Error('not a WebVTT file');
  const out: Cue[] = [];
  for (const b of bs.slice(1)) {
    if (/^(NOTE|STYLE|REGION)\b/.test(b[0])) continue;
    const ti = b.findIndex((l) => TIMING.test(l));
    if (ti < 0) continue;
    const m = b[ti].match(TIMING)!;
    let body = b.slice(ti + 1).join('\n');
    let speaker: string | null = null;
    const vm = body.match(/^<v(?:\.[^ >]*)? ([^>]*)>([\s\S]*?)(?:<\/v>)?$/);
    if (vm) {
      speaker = vm[1].trim();
      body = vm[2];
    }
    out.push({ startMs: subtitleToMs(m[1]), endMs: subtitleToMs(m[2]), speaker, text: vttUnescape(body.replace(/<[^>]+>/g, '')) });
  }
  return out;
}
