import { describe, expect, it } from 'vitest';
import {
  ACTION_STATUSES,
  AI_PROVIDERS,
  AUDIO_RETENTIONS,
  COMMITMENT_STATUSES,
  CONSENT_STATES,
  DECISION_STATUSES,
  EMBEDDING_PROVIDERS,
  FOLLOWUP_KINDS,
  FOLLOWUP_STATUSES,
  LEDGER_ENTITY_TYPES,
  MEETING_STATUSES,
  MEETING_TYPES,
  QUESTION_STATUSES,
  ROLES,
  SEARCH_ENTITY_TYPES,
  NOTIFICATION_KINDS,
  TRANSCRIPTION_MODES,
  VISIBILITIES,
} from '@meetledger/shared';
import { ja } from './ja';
import { en } from './en';
import { interpolate, translate } from './index';
import { computeCapabilities } from '../lib/media';

const jaKeys = Object.keys(ja).sort();
const enKeys = Object.keys(en).sort();
const placeholders = (s: string) => Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]).sort();

// Every source file, as text (Vite glob works in vitest without Node typings).
const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../i18n/ja.ts', '!../i18n/en.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('i18n dictionaries', () => {
  it('ja and en have exactly the same keys', () => {
    expect(enKeys).toEqual(jaKeys);
  });

  it('no empty strings', () => {
    for (const k of jaKeys) {
      expect((ja as Record<string, string>)[k].trim(), `ja ${k}`).not.toBe('');
      expect((en as Record<string, string>)[k].trim(), `en ${k}`).not.toBe('');
    }
  });

  it('placeholders match between languages', () => {
    for (const k of jaKeys) expect(placeholders((en as Record<string, string>)[k]), k).toEqual(placeholders((ja as Record<string, string>)[k]));
  });

  it('every literal t("key") used in the source exists', () => {
    const used = new Set<string>();
    for (const src of Object.values(sources)) for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) used.add(m[1]);
    for (const m of Object.values(sources).join('\n').matchAll(/(?:titleKey|hintKey)="([a-zA-Z0-9_.-]+)"/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(300);
    const missing = [...used].filter((k) => !(k in ja));
    expect(missing).toEqual([]);
  });

  it('every enum-driven key exists (dynamic keys)', () => {
    const need: string[] = [];
    const add = (prefix: string, values: readonly string[], suffix = '') => values.forEach((v) => need.push(`${prefix}.${v}${suffix}`));
    add('meetingType', MEETING_TYPES);
    add('meetingStatus', MEETING_STATUSES);
    add('consentState', CONSENT_STATES);
    add('audioRetention', AUDIO_RETENTIONS);
    add('transcriptionMode', TRANSCRIPTION_MODES);
    add('transcriptionMode', TRANSCRIPTION_MODES, '.hint');
    add('visibility', VISIBILITIES);
    add('actionStatus', ACTION_STATUSES);
    add('commitmentStatus', COMMITMENT_STATUSES);
    add('questionStatus', QUESTION_STATUSES);
    add('decisionStatus', DECISION_STATUSES);
    add('followupKind', FOLLOWUP_KINDS);
    add('followupStatus', FOLLOWUP_STATUSES);
    add('role', ROLES);
    add('aiProvider', AI_PROVIDERS);
    add('embeddingProvider', EMBEDDING_PROVIDERS);
    add('entityType', LEDGER_ENTITY_TYPES);
    add('entity', SEARCH_ENTITY_TYPES);
    add('notifKind', NOTIFICATION_KINDS);
    add('meeting.tab', ['brief', 'capture', 'transcript', 'summary', 'ledger', 'followup', 'ask', 'coach', 'agenda', 'settings', 'export']);
    add('settings', ['privacy', 'members', 'invitations', 'connectors', 'approvals', 'tokens', 'data', 'account']);
    add('sync.status', ['pending', 'conflict', 'failed']);
    add('consent.method', ['in_app', 'verbal', 'calendar_note', 'email', 'chat_message', 'other']);
    add('consentKind', ['recording', 'transcription', 'ai_processing', 'disclosure_shown', 'external_transfer']);
    add('consentRecordState', ['notified', 'confirmed', 'declined', 'acknowledged']);
    add('export.format', ['md', 'html', 'txt', 'srt', 'vtt', 'json']);
    add('decisionView', ['current', 'all', 'candidates', 'superseded']);
    add('commitment.direction', ['mine', 'theirs', 'other']);
    add('commitment.filter', ['all', 'mine', 'theirs']);
    add('review.contradiction.done', ['change', 'not_change', 'dismiss']);
    add('meetingSettings.confirm', ['audio', 'transcript', 'ai', 'meeting']);
    add('ledger.add', ['decision', 'action', 'question']);
    add('ledger.field', ['decision', 'action', 'question']);
    for (const s of ['today', 'upcoming', 'needsReview', 'myActions', 'myCommitments', 'waiting', 'overdue', 'decisionsChanged', 'openQuestions']) need.push(`dash.${s}`, `dash.${s}.empty`);
    need.push('capture.warn.noTabAudio', 'capture.warn.background');
    // every capability notice for a range of environments
    const envs = [true, false].flatMap((secure) =>
      ['iPhone', 'Android', 'Windows NT 10.0) Chrome/141', 'Macintosh) Version/26 Safari/605', 'Firefox/143'].map((ua) => ({
        userAgent: ua,
        hasGetUserMedia: secure,
        hasGetDisplayMedia: true,
        hasMediaRecorder: secure,
        isSecureContext: secure,
      })),
    );
    for (const e of envs) need.push(...computeCapabilities(e).notices);
    const missing = [...new Set(need)].filter((k) => !(k in ja));
    expect(missing).toEqual([]);
  });

  it('ledger terms put the plain word first, then the technical term (ja)', () => {
    expect(ja['entityType.decision']).toBe('決まったこと（Decision）');
    expect(ja['entityType.action']).toBe('やること（Action）');
    expect(ja['entityType.commitment']).toBe('約束（Commitment）');
    expect(ja['entityType.question']).toBe('未解決の問い（Open Question）');
    expect(ja['ai.label']).toBe('AI生成');
    expect(ja['ask.unknown']).toBe('記録からは分かりません');
    expect(ja['sample.label']).toBe('サンプル（架空データ）');
  });

  it('interpolates variables and falls back to the key text', () => {
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(translate('ja', 'sync.badge', { n: 3 })).toBe('未同期 3');
    expect(translate('en', 'sync.badge', { n: 3 })).toBe('Unsynced 3');
  });
});
