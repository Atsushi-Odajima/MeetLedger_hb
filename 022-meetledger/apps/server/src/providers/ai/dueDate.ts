// Due-date expressions (JA + EN) resolved relative to the meeting date (YYYY-MM-DD in the meeting timezone).
// explicit=true only when an absolute calendar date is stated (10月15日, 10/15, 2026-10-15, Oct 15).
// Relative expressions (明日, 来週金曜, 今週中, by Friday) are resolved but flagged as inferred (explicit=false).

export interface DueMatch {
  /** The expression as found (NFKC-normalized). */
  text: string;
  date: string | null;
  explicit: boolean;
  index: number;
}

const DAY = 86_400_000;

function toUtc(d: string): number {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
}
function fromUtc(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
export function isValidYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromUtc(toUtc(s)) === s;
}
function ymd(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidYmd(s) ? s : null;
}
export function addDays(base: string, n: number): string {
  return fromUtc(toUtc(base) + n * DAY);
}
/** 0 = Sunday ... 6 = Saturday */
function dow(base: string): number {
  return new Date(toUtc(base)).getUTCDay();
}
/** Monday of the week containing base (weeks start on Monday). */
function mondayOf(base: string): string {
  return addDays(base, -((dow(base) + 6) % 7));
}
function weekdayOfWeek(base: string, weekOffset: number, wd: number): string {
  return addDays(mondayOf(base), weekOffset * 7 + ((wd + 6) % 7));
}
/** Next occurrence of weekday strictly after base. */
function nextWeekday(base: string, wd: number): string {
  let diff = (wd - dow(base) + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(base, diff);
}
function endOfMonth(y: number, m: number): string {
  return fromUtc(Date.UTC(y, m, 0));
}
function baseYm(base: string): [number, number] {
  const [y, m] = base.split('-').map(Number);
  return [y, m];
}
/** Month/day without a year: the meeting year, or next year when that date is long past. */
function withYear(base: string, m: number, d: number): string | null {
  const [y] = baseYm(base);
  const cand = ymd(y, m, d);
  if (!cand) return null;
  if (toUtc(cand) < toUtc(base) - 60 * DAY) return ymd(y + 1, m, d);
  return cand;
}

const WD_JA: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
const WD_EN: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MON_EN: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const EN_WD = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)';
const EN_MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

type Resolver = (m: RegExpExecArray, base: string) => { date: string | null; explicit: boolean } | null;
const rules: { re: RegExp; resolve: Resolver }[] = [
  // ---- absolute (explicit)
  { re: /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g, resolve: (m) => ({ date: ymd(+m[1], +m[2], +m[3]), explicit: true }) },
  { re: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g, resolve: (m) => ({ date: ymd(+m[1], +m[2], +m[3]), explicit: true }) },
  { re: /(\d{1,2})月\s*(\d{1,2})日/g, resolve: (m, b) => ({ date: withYear(b, +m[1], +m[2]), explicit: true }) },
  { re: /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, resolve: (m, b) => ({ date: withYear(b, +m[1], +m[2]), explicit: true }) },
  { re: new RegExp(`\\b${EN_MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'), resolve: (m, b) => ({ date: withYear(b, MON_EN[m[1].slice(0, 3).toLowerCase()], +m[2]), explicit: true }) },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${EN_MON}\\b`, 'gi'), resolve: (m, b) => ({ date: withYear(b, MON_EN[m[2].slice(0, 3).toLowerCase()], +m[1]), explicit: true }) },
  // ---- relative / approximate (inferred)
  {
    re: /(\d{1,2})月\s*(末|中|いっぱい|上旬|中旬|下旬)/g,
    resolve: (m, b) => {
      const mo = +m[1];
      const first = withYear(b, mo, 1);
      if (!first) return null;
      const [y] = baseYm(first);
      const d = m[2] === '上旬' ? 10 : m[2] === '中旬' ? 20 : Number(endOfMonth(y, mo).slice(8));
      return { date: ymd(y, mo, d), explicit: false };
    },
  },
  {
    re: /(再来週|来週|今週)の?\s*([月火水木金土日])曜日?/g,
    resolve: (m, b) => ({ date: weekdayOfWeek(b, m[1] === '今週' ? 0 : m[1] === '来週' ? 1 : 2, WD_JA[m[2]]), explicit: false }),
  },
  { re: /(再来週|来週|今週)(中|末|いっぱい|まで)/g, resolve: (m, b) => ({ date: weekdayOfWeek(b, m[1] === '今週' ? 0 : m[1] === '来週' ? 1 : 2, 5), explicit: false }) },
  { re: /(明後日|あさって)/g, resolve: (_m, b) => ({ date: addDays(b, 2), explicit: false }) },
  { re: /(明日|あした)/g, resolve: (_m, b) => ({ date: addDays(b, 1), explicit: false }) },
  { re: /(本日|今日)(中)?/g, resolve: (_m, b) => ({ date: b, explicit: false }) },
  { re: /(?<![今来週])([月火水木金土日])曜日?/g, resolve: (m, b) => ({ date: nextWeekday(b, WD_JA[m[1]]), explicit: false }) },
  {
    re: /来月(末|中|いっぱい)/g,
    resolve: (_m, b) => {
      const [y, mo] = baseYm(b);
      return { date: mo === 12 ? endOfMonth(y + 1, 1) : endOfMonth(y, mo + 1), explicit: false };
    },
  },
  {
    re: /(?<![\d来])月末/g,
    resolve: (_m, b) => {
      const [y, mo] = baseYm(b);
      return { date: endOfMonth(y, mo), explicit: false };
    },
  },
  { re: /年内/g, resolve: (_m, b) => ({ date: ymd(baseYm(b)[0], 12, 31), explicit: false }) },
  { re: /(\d{1,3})\s*日後/g, resolve: (m, b) => ({ date: addDays(b, +m[1]), explicit: false }) },
  { re: /(\d{1,2})\s*週間後/g, resolve: (m, b) => ({ date: addDays(b, 7 * +m[1]), explicit: false }) },
  {
    re: /(?<![\d月/])(\d{1,2})日(まで|までに|中|に|締め)/g,
    resolve: (m, b) => {
      const [y, mo] = baseYm(b);
      let d = ymd(y, mo, +m[1]);
      if (d && toUtc(d) < toUtc(b)) d = mo === 12 ? ymd(y + 1, 1, +m[1]) : ymd(y, mo + 1, +m[1]);
      return { date: d, explicit: false };
    },
  },
  { re: /\b(today|eod|end of (?:the )?day)\b/gi, resolve: (_m, b) => ({ date: b, explicit: false }) },
  { re: /\btomorrow\b/gi, resolve: (_m, b) => ({ date: addDays(b, 1), explicit: false }) },
  { re: new RegExp(`\\bnext\\s+${EN_WD}\\b`, 'gi'), resolve: (m, b) => ({ date: weekdayOfWeek(b, 1, WD_EN[m[1].toLowerCase()]), explicit: false }) },
  { re: new RegExp(`\\bthis\\s+${EN_WD}\\b`, 'gi'), resolve: (m, b) => ({ date: weekdayOfWeek(b, 0, WD_EN[m[1].toLowerCase()]), explicit: false }) },
  { re: new RegExp(`\\b(?:by|on|until|before|due)\\s+${EN_WD}\\b`, 'gi'), resolve: (m, b) => ({ date: nextWeekday(b, WD_EN[m[1].toLowerCase()]), explicit: false }) },
  { re: /\b(end of (?:the |this )?week|this week|eow)\b/gi, resolve: (_m, b) => ({ date: weekdayOfWeek(b, 0, 5), explicit: false }) },
  { re: /\bnext week\b/gi, resolve: (_m, b) => ({ date: weekdayOfWeek(b, 1, 5), explicit: false }) },
  {
    re: /\b(end of (?:the |this )?month|eom)\b/gi,
    resolve: (_m, b) => {
      const [y, mo] = baseYm(b);
      return { date: endOfMonth(y, mo), explicit: false };
    },
  },
];

/** Finds the first due-date expression in `text`. `base` = meeting date (YYYY-MM-DD) or null (then dates stay null). */
export function findDue(text: string, base: string | null): DueMatch | null {
  const t = text.normalize('NFKC');
  let best: DueMatch | null = null;
  for (const r of rules) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(t))) {
      const res = base ? r.resolve(m, base) : { date: null, explicit: /\d/.test(m[0]) && !/(後|末|中|旬)/.test(m[0]) };
      if (res && (!best || m.index < best.index || (m.index === best.index && m[0].length > best.text.length))) {
        best = { text: m[0].trim(), date: res.date, explicit: res.explicit && !!res.date, index: m.index };
      }
      if (!r.re.global) break;
    }
  }
  return best;
}

/** Parses a whole due expression (as given by an AI provider). Returns null when no known expression is contained. */
export function parseDue(text: string, base: string | null): DueMatch | null {
  return findDue(text, base);
}
