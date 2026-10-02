import type { FollowupKind, MeetingType, Visibility } from './enums';

/** Built-in meeting templates. Workspaces may add custom templates (stored in DB) with the same shape. */
export interface MeetingTemplate {
  key: string;
  name: string;
  meetingType: MeetingType;
  defaultVisibility: Visibility;
  agenda: string[];
  /** Ordered summary sections rendered for this template. */
  summarySections: SummarySectionKey[];
  extractionRules: {
    decisions: boolean;
    actions: boolean;
    commitments: boolean;
    questions: boolean;
    risks: boolean;
    /** Extra hints for LLM providers (never instructions that change policy). */
    hints: string[];
  };
  followupStyle: {
    defaultKinds: FollowupKind[];
    tone: 'formal' | 'neutral' | 'casual';
  };
}

export const SUMMARY_SECTIONS = ['executive', 'topics', 'decisions', 'actions', 'commitments', 'questions', 'risks', 'next_meeting'] as const;
export type SummarySectionKey = (typeof SUMMARY_SECTIONS)[number];

const ALL: SummarySectionKey[] = [...SUMMARY_SECTIONS];

export const BUILTIN_TEMPLATES: MeetingTemplate[] = [
  {
    key: 'client',
    name: 'Client Meeting',
    meetingType: 'client',
    defaultVisibility: 'workspace',
    agenda: ['前回の約束の確認', '今回の議題', '決定事項の確認', '次回までのアクション'],
    summarySections: ALL,
    extractionRules: { decisions: true, actions: true, commitments: true, questions: true, risks: true, hints: ['先方/当方どちらの約束かを区別する'] },
    followupStyle: { defaultKinds: ['thank_you_email', 'client_recap', 'internal_recap'], tone: 'formal' },
  },
  {
    key: 'weekly_team',
    name: 'Weekly Team',
    meetingType: 'internal',
    defaultVisibility: 'workspace',
    agenda: ['先週のAction確認', '進捗共有', '課題・ブロッカー', '決定事項', '今週のAction'],
    summarySections: ALL,
    extractionRules: { decisions: true, actions: true, commitments: false, questions: true, risks: true, hints: [] },
    followupStyle: { defaultKinds: ['internal_recap', 'slack_update'], tone: 'neutral' },
  },
  {
    key: 'one_on_one',
    name: '1on1',
    meetingType: 'one_on_one',
    defaultVisibility: 'private',
    agenda: ['前回のフォローアップ', '話したいトピック', '次回までにやること'],
    summarySections: ['executive', 'topics', 'actions', 'commitments', 'questions', 'next_meeting'],
    extractionRules: { decisions: false, actions: true, commitments: true, questions: true, risks: false, hints: ['評価・心理分析は行わない'] },
    followupStyle: { defaultKinds: ['internal_recap'], tone: 'casual' },
  },
  {
    key: 'sales_discovery',
    name: 'Sales Discovery',
    meetingType: 'sales',
    defaultVisibility: 'workspace',
    agenda: ['先方の現状と課題', '要件', '予算・時期', '次のステップ'],
    summarySections: ALL,
    extractionRules: { decisions: true, actions: true, commitments: true, questions: true, risks: true, hints: ['先方の発言を推測で補完しない'] },
    followupStyle: { defaultKinds: ['thank_you_email', 'internal_recap'], tone: 'formal' },
  },
  {
    key: 'project_review',
    name: 'Project Review',
    meetingType: 'project',
    defaultVisibility: 'workspace',
    agenda: ['マイルストーン状況', 'リスク', '変更事項', '決定事項', '次のAction'],
    summarySections: ALL,
    extractionRules: { decisions: true, actions: true, commitments: true, questions: true, risks: true, hints: [] },
    followupStyle: { defaultKinds: ['internal_recap', 'client_recap'], tone: 'neutral' },
  },
  {
    key: 'workshop',
    name: 'Workshop',
    meetingType: 'workshop',
    defaultVisibility: 'workspace',
    agenda: ['目的', 'アイデア出し', '整理・合意', '次のステップ'],
    summarySections: ['executive', 'topics', 'decisions', 'actions', 'questions', 'next_meeting'],
    extractionRules: { decisions: true, actions: true, commitments: false, questions: true, risks: false, hints: [] },
    followupStyle: { defaultKinds: ['internal_recap'], tone: 'neutral' },
  },
  {
    key: 'interview',
    name: 'Interview (記録のみ)',
    meetingType: 'interview',
    defaultVisibility: 'selected',
    agenda: ['事前に伝えた内容の確認', '質疑', '次のステップ'],
    summarySections: ['executive', 'topics', 'actions', 'questions', 'next_meeting'],
    extractionRules: { decisions: false, actions: true, commitments: true, questions: true, risks: false, hints: ['候補者の人格・能力を評価しない'] },
    followupStyle: { defaultKinds: ['internal_recap'], tone: 'formal' },
  },
  {
    key: 'other',
    name: 'General',
    meetingType: 'other',
    defaultVisibility: 'workspace',
    agenda: [],
    summarySections: ALL,
    extractionRules: { decisions: true, actions: true, commitments: true, questions: true, risks: true, hints: [] },
    followupStyle: { defaultKinds: ['internal_recap'], tone: 'neutral' },
  },
];

export function defaultTemplateFor(type: MeetingType): MeetingTemplate {
  const map: Partial<Record<MeetingType, string>> = {
    client: 'client',
    internal: 'weekly_team',
    one_on_one: 'one_on_one',
    sales: 'sales_discovery',
    project: 'project_review',
    workshop: 'workshop',
    interview: 'interview',
  };
  const key = map[type] ?? 'other';
  return BUILTIN_TEMPLATES.find((t) => t.key === key)!;
}

export function findBuiltinTemplate(key: string | null | undefined): MeetingTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.key === key);
}
