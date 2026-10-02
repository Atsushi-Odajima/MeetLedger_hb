// Session and webContents hardening (Electron security checklist):
//  - only the configured server origin + bundled app://desktop pages are ever loaded in our windows
//  - navigation / redirects / window.open to other origins are blocked (https links open in the OS browser)
//  - <webview> is refused; no permission is granted except microphone ('media', audio only) and 'display-capture'
//  - system-audio capture (getDisplayMedia → loopback) is granted ONLY to the desktop recorder page while a
//    consent-verified recording session is armed (see RecorderSession), never to remote content

import { desktopCapturer, shell, webContents as WebContentsApi, type Session, type WebContents } from 'electron';
import { decideNavigation, isLocalPage, LOCAL_ORIGIN, originOf } from '../shared/urlPolicy';

export interface SecurityDeps {
  serverOrigin: () => string | null;
  isMainWindow: (wc: WebContents) => boolean;
  isRecorderWindow: (wc: WebContents) => boolean;
  captureAllowed: (wc: WebContents) => boolean;
  /** platform decides whether loopback is requested at all */
  systemAudioSupported: () => boolean;
  /** macOS 15+ experimental native picker (workaround knob for Electron issue #52738; read once at startup) */
  useSystemPicker: boolean;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

function openExternalSafely(url: string, deps: SecurityDeps): void {
  const u = new URL(url);
  if (u.protocol === 'https:' || u.protocol === 'mailto:') {
    void shell.openExternal(u.toString());
    deps.log('opened externally', { origin: u.protocol === 'mailto:' ? 'mailto' : u.origin });
  }
}

export function installSessionSecurity(ses: Session, deps: SecurityDeps): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = originOf(details.requestingUrl ?? '');
    const fromServer = !!origin && origin === deps.serverOrigin() && !!wc && deps.isMainWindow(wc);
    const fromRecorder = origin === LOCAL_ORIGIN && !!wc && deps.isRecorderWindow(wc) && isLocalPage(details.requestingUrl ?? '', 'recorder');
    let allow = false;
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      const audioOnly = types.length > 0 && types.every((t) => t === 'audio');
      // Web app: microphone (its own browser-capture flow, consent enforced by the server's /start).
      // Recorder page: microphone only while a consent-verified session is armed.
      allow = audioOnly && (fromServer || (fromRecorder && deps.captureAllowed(wc!)));
    } else if (permission === 'display-capture') {
      allow = fromRecorder && deps.captureAllowed(wc!);
    }
    if (!allow) deps.log('permission denied', { permission, origin: origin ?? 'opaque' });
    callback(allow);
  });

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (permission !== 'media') return false;
    const origin = originOf(requestingOrigin);
    if (origin && origin === deps.serverOrigin()) return true;
    return origin === LOCAL_ORIGIN && !!wc && deps.isRecorderWindow(wc);
  });

  ses.setDevicePermissionHandler(() => false); // no WebHID / WebUSB / Web Serial
  ses.on('select-hid-device', (e, _d, cb) => {
    e.preventDefault();
    cb('');
  });
  ses.on('select-serial-port', (e, _p, _wc, cb) => {
    e.preventDefault();
    cb('');
  });
  ses.on('select-usb-device', (e, _d, cb) => {
    e.preventDefault();
    cb('');
  });

  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const frame = request.frame;
      const wc = frame ? webContentsOfFrame(frame) : null;
      const ok =
        !!frame &&
        !!wc &&
        frame === wc.mainFrame &&
        request.securityOrigin === LOCAL_ORIGIN &&
        deps.isRecorderWindow(wc) &&
        deps.captureAllowed(wc) &&
        deps.systemAudioSupported();
      if (!ok) {
        deps.log('display media denied', { origin: request.securityOrigin });
        callback({});
        return;
      }
      // Video source = the recorder page itself (tab capture), NOT the screen: we never capture screen content.
      // The renderer stops the video track immediately; only the loopback (system) audio track is recorded.
      try {
        callback({ video: frame!, audio: 'loopback' });
      } catch (e) {
        deps.log('display media failed', { error: (e as Error).message });
        // Fallback for platforms that refuse frame video + loopback: a screen source (video track is stopped at once).
        void desktopCapturer
          .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => (sources[0] ? callback({ video: sources[0], audio: 'loopback' }) : callback({})))
          .catch(() => callback({}));
      }
    },
    { useSystemPicker: deps.useSystemPicker },
  );
}

function webContentsOfFrame(frame: Electron.WebFrameMain): WebContents | null {
  try {
    return WebContentsApi.fromFrame(frame) ?? null;
  } catch {
    return null;
  }
}

/** Applied to every webContents created by the app. */
export function hardenWebContents(contents: WebContents, deps: SecurityDeps): void {
  contents.on('will-attach-webview', (e) => e.preventDefault());

  contents.setWindowOpenHandler(({ url }) => {
    const d = decideNavigation(url, deps.serverOrigin(), { allowInWindow: false });
    if (d === 'external') openExternalSafely(url, deps);
    return { action: 'deny' };
  });

  const guard = (e: Electron.Event, url: string, isMainFrame: boolean) => {
    const local = isLocalPage(contents.getURL());
    // local pages (settings / recorder) never navigate anywhere; the main window may move within the server origin
    const allowInWindow = !local && deps.isMainWindow(contents);
    const d = decideNavigation(url, deps.serverOrigin(), { allowInWindow });
    if (d === 'allow') return;
    e.preventDefault();
    if (d === 'external' && isMainFrame) openExternalSafely(url, deps);
    else deps.log('navigation blocked', { origin: originOf(url) ?? 'opaque' });
  };
  contents.on('will-navigate', (e) => guard(e, e.url, e.isMainFrame));
  contents.on('will-redirect', (e) => guard(e, e.url, e.isMainFrame));
  contents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return; // handled by will-navigate
    guard(e, e.url, false);
  });
}
