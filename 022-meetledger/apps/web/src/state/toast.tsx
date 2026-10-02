import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { errorMessage } from '../lib/api';

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
  action?: { label: string; onClick(): void };
}

interface ToastApi {
  success(text: string): void;
  info(text: string, action?: Toast['action']): void;
  error(e: unknown): void;
  /** Screen-reader only status message (aria-live). */
  announce(text: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [live, setLive] = useState('');
  const seq = useRef(0);
  const push = useCallback((tone: ToastTone, text: string, action?: Toast['action']) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, tone, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : action ? 15000 : 4000);
  }, []);
  const api = useMemo<ToastApi>(
    () => ({
      success: (text) => push('success', text),
      info: (text, action) => push('info', text, action),
      error: (e) => push('error', typeof e === 'string' ? e : errorMessage(e)),
      announce: (text) => {
        setLive('');
        setTimeout(() => setLive(text), 30);
      },
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : undefined}>
            <Icon name={t.tone === 'success' ? 'check' : t.tone === 'error' ? 'alert' : 'info'} />
            <span>{t.text}</span>
            {t.action && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={t.action.onClick}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="sr-only" aria-live="polite" role="status">
        {live}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(ToastContext);
  if (!v) throw new Error('useToast outside ToastProvider');
  return v;
}
