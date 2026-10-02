import { useId, useState, type KeyboardEvent } from 'react';
import { AUDIO_RETENTIONS, type AudioRetention, type TranscriptionMode, type Visibility } from '@meetledger/shared';
import { Badge, Checkbox, RadioGroup, SelectField, TextField, Toggle } from './ui';
import { Icon } from './Icon';
import { useI18n, type MsgKey } from '../i18n';
import { useWs } from '../state/workspace';
import { usePeople } from './ledger';
import { useApi } from '../lib/hooks';
import { listOf } from '../lib/api';
import type { MemberDto } from '../lib/types';

export interface PrivacyValue {
  transcriptionMode: TranscriptionMode;
  aiEnabled: boolean;
  isConfidential: boolean;
  audioRetention: AudioRetention;
  audioRetentionDays: number | null;
}

/** Applies the Confidential preset (mirrors the server rules so the form shows what will actually be stored). */
export function applyConfidential(v: PrivacyValue): PrivacyValue {
  if (!v.isConfidential) return v;
  return {
    ...v,
    aiEnabled: false,
    transcriptionMode: v.transcriptionMode === 'cloud' ? 'local' : v.transcriptionMode,
    audioRetention: v.audioRetention === 'never' || v.audioRetention === 'until_processed' ? v.audioRetention : 'until_processed',
    audioRetentionDays: null,
  };
}

export function PrivacyFields({ value, onChange, disabled }: { value: PrivacyValue; onChange(v: PrivacyValue): void; disabled?: boolean }) {
  const { t } = useI18n();
  const { ws } = useWs();
  const cloudAllowed = !!ws?.settings.transcription.cloudAllowed && ws?.processing.installation.cloudTranscriptionProvider !== 'none';
  const set = (patch: Partial<PrivacyValue>) => onChange(applyConfidential({ ...value, ...patch }));
  const conf = value.isConfidential;
  return (
    <div className="stack privacy-fields">
      <Toggle
        label={
          <>
            <Icon name="lock" size={16} /> {t('privacy.confidentialPreset')}
          </>
        }
        hint={t('privacy.confidentialHint')}
        checked={conf}
        onChange={(v) => set({ isConfidential: v })}
        disabled={disabled}
      />
      <RadioGroup<TranscriptionMode>
        legend={t('privacy.transcription')}
        value={value.transcriptionMode}
        onChange={(v) => set({ transcriptionMode: v })}
        options={[
          { value: 'local', label: t('transcriptionMode.local'), hint: t('transcriptionMode.local.hint'), disabled },
          {
            value: 'cloud',
            label: t('transcriptionMode.cloud'),
            hint: conf ? t('privacy.lockedByConfidential') : cloudAllowed ? t('transcriptionMode.cloud.hint') : t('transcriptionMode.cloud.notAllowed'),
            disabled: disabled || conf || !cloudAllowed,
          },
          { value: 'none', label: t('transcriptionMode.none'), hint: t('transcriptionMode.none.hint'), disabled },
        ]}
      />
      <Toggle
        label={t('privacy.aiProcessing')}
        hint={conf ? t('privacy.lockedByConfidential') : value.aiEnabled ? t('privacy.aiOn.hint') : t('privacy.aiOff.hint')}
        checked={value.aiEnabled}
        onChange={(v) => set({ aiEnabled: v })}
        disabled={disabled || conf}
      />
      <div className="grid-2">
        <SelectField
          label={t('privacy.audioRetention')}
          value={value.audioRetention}
          onChange={(e) => set({ audioRetention: e.target.value as AudioRetention, audioRetentionDays: e.target.value === 'custom' ? (value.audioRetentionDays ?? 90) : null })}
          disabled={disabled}
          hint={t('privacy.audioRetention.hint')}
          options={AUDIO_RETENTIONS.map((r) => ({
            value: r,
            label: t(`audioRetention.${r}` as MsgKey),
            disabled: conf && r !== 'never' && r !== 'until_processed',
          }))}
        />
        {value.audioRetention === 'custom' && (
          <TextField
            label={t('privacy.audioRetentionDays')}
            type="number"
            min={1}
            max={3650}
            value={value.audioRetentionDays ?? ''}
            onChange={(e) => set({ audioRetentionDays: e.target.value ? Number(e.target.value) : null })}
            disabled={disabled}
            required
          />
        )}
      </div>
    </div>
  );
}

export interface ParticipantInput {
  personId?: string;
  name?: string;
  email?: string | null;
  role?: 'organizer' | 'attendee' | 'optional';
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** "山田 太郎 <taro@example.com>", "taro@example.com" or a name. */
export function parseParticipant(raw: string): ParticipantInput | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(.*)<([^>]+)>$/);
  if (m && EMAIL_RE.test(m[2].trim())) return { name: m[1].trim() || undefined, email: m[2].trim().toLowerCase() };
  if (EMAIL_RE.test(s)) return { email: s.toLowerCase() };
  return { name: s.slice(0, 100) };
}

export function ParticipantsInput({ value, onChange, disabled }: { value: ParticipantInput[]; onChange(v: ParticipantInput[]): void; disabled?: boolean }) {
  const { t } = useI18n();
  const { people, byId } = usePeople();
  const [text, setText] = useState('');
  const id = useId();
  const add = () => {
    const parsed = parseParticipant(text);
    if (!parsed) return;
    const match = people.find((p) => (parsed.email && p.email?.toLowerCase() === parsed.email) || (!parsed.email && p.name === parsed.name));
    const next: ParticipantInput = match ? { personId: match.id, role: 'attendee' } : { ...parsed, role: 'attendee' };
    const dup = value.some((v) => (next.personId && v.personId === next.personId) || (next.email && v.email === next.email) || (!next.email && !next.personId && v.name === next.name));
    if (!dup) onChange([...value, next]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    }
  };
  const label = (p: ParticipantInput) => (p.personId ? (byId.get(p.personId)?.name ?? '…') : (p.name ?? p.email ?? ''));
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('meeting.participants')}
      </label>
      <div className="chips" aria-live="polite">
        {value.map((p, i) => (
          <span className="chip" key={i}>
            <span>{label(p)}</span>
            {p.email && !p.personId && <span className="muted">{p.email}</span>}
            {p.role === 'organizer' && <Badge tone="info">{t('participant.organizer')}</Badge>}
            {!disabled && (
              <>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => onChange(value.map((v, j) => (j === i ? { ...v, role: v.role === 'organizer' ? 'attendee' : 'organizer' } : v)))}
                  aria-label={t('participant.toggleOrganizer', { name: label(p) })}
                  title={t('participant.toggleOrganizer', { name: label(p) })}
                >
                  ★
                </button>
                <button type="button" className="chip-btn" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('participant.remove', { name: label(p) })}>
                  <Icon name="x" size={14} />
                </button>
              </>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <div className="inline-input">
          <input
            id={id}
            className="input"
            list={`${id}-people`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={t('participant.placeholder')}
            aria-describedby={`${id}-hint`}
          />
          <button type="button" className="btn btn-secondary btn-md" onClick={add} disabled={!text.trim()}>
            {t('common.add')}
          </button>
          <datalist id={`${id}-people`}>
            {people.map((p) => (
              <option key={p.id} value={p.email ? `${p.name} <${p.email}>` : p.name} />
            ))}
          </datalist>
        </div>
      )}
      <p className="field-hint" id={`${id}-hint`}>
        {t('participant.hint')}
      </p>
    </div>
  );
}

export function VisibilityFields({
  visibility,
  onVisibility,
  accessUserIds,
  onAccess,
  disabled,
  confidential,
}: {
  visibility: Visibility;
  onVisibility(v: Visibility): void;
  accessUserIds: string[];
  onAccess(ids: string[]): void;
  disabled?: boolean;
  confidential?: boolean;
}) {
  const { t } = useI18n();
  const { a } = useWs();
  const members = useApi<unknown>(visibility === 'selected' ? a('/members') : null);
  return (
    <div className="stack">
      <RadioGroup<Visibility>
        legend={t('meeting.visibility')}
        value={visibility}
        onChange={onVisibility}
        options={[
          { value: 'private', label: t('visibility.private'), hint: t('visibility.private.hint'), disabled },
          { value: 'workspace', label: t('visibility.workspace'), hint: confidential ? t('privacy.lockedByConfidential') : t('visibility.workspace.hint'), disabled: disabled || confidential },
          { value: 'selected', label: t('visibility.selected'), hint: t('visibility.selected.hint'), disabled },
        ]}
      />
      {visibility === 'selected' && (
        <fieldset className="radio-group">
          <legend className="field-label">{t('meeting.accessUsers')}</legend>
          {listOf<MemberDto>(members.data, 'members').map((m) => (
            <Checkbox
              key={m.id}
              label={`${m.name} (${m.email})`}
              checked={accessUserIds.includes(m.id)}
              disabled={disabled}
              onChange={(e) => onAccess(e.target.checked ? [...accessUserIds, m.id] : accessUserIds.filter((x) => x !== m.id))}
            />
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** datetime-local <-> ISO helpers (browser local time). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
