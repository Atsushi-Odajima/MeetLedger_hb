// Service worker registration, update prompt and install hint plumbing.

type Listener = () => void;
let waiting: ServiceWorker | null = null;
const updateListeners = new Set<Listener>();

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let deferredInstall: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<Listener>();

export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
    installListeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    installListeners.forEach((l) => l());
  });
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const track = (w: ServiceWorker | null) => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            waiting = w;
            updateListeners.forEach((l) => l());
          }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) {
        waiting = reg.waiting;
        updateListeners.forEach((l) => l());
      }
      reg.addEventListener('updatefound', () => track(reg.installing));
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading || !waiting) return;
        reloading = true;
        window.location.reload();
      });
      setInterval(() => reg.update().catch(() => undefined), 60 * 60 * 1000);
      // Ask the browser to keep our offline data (Safari evicts script storage after 7 days without use otherwise).
      navigator.storage?.persist?.().catch(() => undefined);
    } catch {
      /* SW is an enhancement only */
    }
  });
}

export function onUpdateAvailable(l: Listener): () => void {
  updateListeners.add(l);
  if (waiting) l();
  return () => updateListeners.delete(l);
}

export function applyUpdate() {
  waiting?.postMessage({ type: 'skip-waiting' });
}

export function clearServiceWorkerApiCache() {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'clear-api-cache' });
  } catch {
    /* ignore */
  }
}

export function canPromptInstall(): boolean {
  return !!deferredInstall;
}

export function onInstallAvailability(l: Listener): () => void {
  installListeners.add(l);
  return () => installListeners.delete(l);
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredInstall) return false;
  await deferredInstall.prompt();
  const choice = await deferredInstall.userChoice;
  deferredInstall = null;
  installListeners.forEach((l) => l());
  return choice.outcome === 'accepted';
}
