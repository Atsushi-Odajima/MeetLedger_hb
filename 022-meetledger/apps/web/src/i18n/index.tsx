import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ja } from './ja';
import { en } from './en';

export type MsgKey = keyof typeof ja;
export type Lang = 'ja' | 'en';
export type Vars = Record<string, string | number | null | undefined>;

export const dictionaries: Record<Lang, Record<MsgKey, string>> = { ja, en };
export const LANG_STORAGE_KEY = 'ml.lang';

export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

export function translate(lang: Lang, key: MsgKey, vars?: Vars): string {
  const s = dictionaries[lang][key] ?? dictionaries.ja[key] ?? key;
  return interpolate(s, vars);
}

/** For values coming from the server (job states, providers…): translated when a key exists, else shown verbatim. */
export function translateMaybe(lang: Lang, key: string, fallback: string): string {
  const d = dictionaries[lang] as Record<string, string>;
  return d[key] ?? (dictionaries.ja as Record<string, string>)[key] ?? fallback;
}

export interface Formatters {
  dateTime(iso: string | null | undefined): string;
  date(iso: string | null | undefined): string;
  time(iso: string | null | undefined): string;
  dayLabel(iso: string | null | undefined): string;
  relative(iso: string | null | undefined): string;
}

interface I18nValue {
  lang: Lang;
  setLang(l: Lang): void;
  timeZone: string;
  setTimeZone(tz: string): void;
  t(key: MsgKey, vars?: Vars): string;
  tm(key: string, fallback: string): string;
  fmt: Formatters;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    if (v === 'ja' || v === 'en') return v;
  } catch {
    /* storage may be blocked */
  }
  return 'ja';
}

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
  } catch {
    return 'Asia/Tokyo';
  }
}

export function makeFormatters(lang: Lang, timeZone: string, t: (k: MsgKey, v?: Vars) => string): Formatters {
  const locale = lang === 'ja' ? 'ja-JP' : 'en-US';
  const safeTz = (() => {
    try {
      new Intl.DateTimeFormat('en', { timeZone });
      return timeZone;
    } catch {
      return undefined;
    }
  })();
  const dt = new Intl.DateTimeFormat(locale, { timeZone: safeTz, month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const d = new Intl.DateTimeFormat(locale, { timeZone: safeTz, year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
  const tm = new Intl.DateTimeFormat(locale, { timeZone: safeTz, hour: '2-digit', minute: '2-digit' });
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: safeTz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parse = (iso: string | null | undefined) => {
    if (!iso) return null;
    // date-only values are calendar dates, not instants
    const v = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
    return Number.isNaN(v.getTime()) ? null : v;
  };
  const dayDiff = (v: Date) => {
    const a = Date.parse(ymd.format(v));
    const b = Date.parse(ymd.format(new Date()));
    return Math.round((a - b) / 86400000);
  };
  return {
    dateTime: (iso) => {
      const v = parse(iso);
      return v ? dt.format(v) : '—';
    },
    date: (iso) => {
      const v = parse(iso);
      if (!v) return '—';
      if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }).format(v);
      return d.format(v);
    },
    time: (iso) => {
      const v = parse(iso);
      return v ? tm.format(v) : '—';
    },
    dayLabel: (iso) => {
      const v = parse(iso);
      if (!v) return '—';
      const diff = dayDiff(v);
      if (diff === 0) return t('time.today');
      if (diff === 1) return t('time.tomorrow');
      if (diff === -1) return t('time.yesterday');
      return d.format(v);
    },
    relative: (iso) => {
      const v = parse(iso);
      if (!v) return '—';
      const sec = Math.round((Date.now() - v.getTime()) / 1000);
      if (Math.abs(sec) < 60) return t('time.justNow');
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      const abs = Math.abs(sec);
      if (abs < 3600) return rtf.format(-Math.round(sec / 60), 'minute');
      if (abs < 86400) return rtf.format(-Math.round(sec / 3600), 'hour');
      return rtf.format(-Math.round(sec / 86400), 'day');
    },
  };
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [timeZone, setTimeZone] = useState<string>(browserTz);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo<I18nValue>(() => {
    const t = (key: MsgKey, vars?: Vars) => translate(lang, key, vars);
    return { lang, setLang, timeZone, setTimeZone, t, tm: (k, f) => translateMaybe(lang, k, f), fmt: makeFormatters(lang, timeZone, t) };
  }, [lang, setLang, timeZone]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
