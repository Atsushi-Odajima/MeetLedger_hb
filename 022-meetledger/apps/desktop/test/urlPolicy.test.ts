import { describe, expect, it } from 'vitest';
import { classifySenderUrl, decideNavigation, isLocalPage, localAssetPath, normalizeServerUrl, originOf, LOCAL_PAGES } from '../src/shared/urlPolicy';
import { CH, CHANNEL_ACL } from '../src/shared/ipc';

const SERVER = 'https://meetledger.example.co.jp';

describe('server URL normalization', () => {
  it('produces an origin and requires https except loopback', () => {
    expect(normalizeServerUrl('meetledger.example.co.jp')).toBe(SERVER);
    expect(normalizeServerUrl('https://meetledger.example.co.jp:8443/app/')).toBe('https://meetledger.example.co.jp:8443');
    expect(normalizeServerUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeServerUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => normalizeServerUrl('http://meetledger.example.co.jp')).toThrow(/https/);
    expect(() => normalizeServerUrl('https://user:pw@meetledger.example.co.jp')).toThrow(/認証情報/);
    expect(() => normalizeServerUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeServerUrl('javascript:alert(1)')).toThrow();
    expect(() => normalizeServerUrl('')).toThrow();
  });
});

describe('navigation allow-list', () => {
  it('allows only the configured origin inside the main window', () => {
    expect(decideNavigation(`${SERVER}/w/abc`, SERVER, { allowInWindow: true })).toBe('allow');
    expect(decideNavigation('https://meetledger.example.co.jp.evil.com/', SERVER, { allowInWindow: true })).toBe('external');
    expect(decideNavigation('https://accounts.google.com/o/oauth2', SERVER, { allowInWindow: true })).toBe('external');
    expect(decideNavigation('http://meetledger.example.co.jp/', SERVER, { allowInWindow: true })).toBe('deny'); // scheme downgrade
    expect(decideNavigation('https://meetledger.example.co.jp:444/', SERVER, { allowInWindow: true })).toBe('external'); // other port = other origin
    expect(decideNavigation('file:///C:/Windows/system32/calc.exe', SERVER, { allowInWindow: true })).toBe('deny');
    expect(decideNavigation('javascript:alert(1)', SERVER, { allowInWindow: true })).toBe('deny');
    expect(decideNavigation('data:text/html,<script>1</script>', SERVER, { allowInWindow: true })).toBe('deny');
    expect(decideNavigation('ms-settings:privacy', SERVER, { allowInWindow: true })).toBe('deny');
    expect(decideNavigation('mailto:a@example.com', SERVER, { allowInWindow: true })).toBe('external');
    expect(decideNavigation('not a url', SERVER, { allowInWindow: true })).toBe('deny');
  });

  it('window.open / local pages never navigate in-window', () => {
    expect(decideNavigation(`${SERVER}/x`, SERVER, { allowInWindow: false })).toBe('external');
    expect(decideNavigation(LOCAL_PAGES.recorder, SERVER, { allowInWindow: false })).toBe('deny');
  });

  it('without a configured server nothing is allowed in-window', () => {
    expect(decideNavigation(`${SERVER}/`, null, { allowInWindow: true })).toBe('external');
  });
});

describe('IPC sender classification', () => {
  it('maps origins / local pages to sender kinds', () => {
    expect(classifySenderUrl(`${SERVER}/w/1/meetings`, SERVER)).toBe('web');
    expect(classifySenderUrl(`${LOCAL_PAGES.settings}?error=x`, SERVER)).toBe('settings');
    expect(classifySenderUrl(`${LOCAL_PAGES.recorder}?ws=1`, SERVER)).toBe('recorder');
    expect(classifySenderUrl('https://evil.example/', SERVER)).toBeNull();
    expect(classifySenderUrl('app://desktop/recorder/other.html', SERVER)).toBeNull();
    expect(classifySenderUrl('app://other/recorder/index.html', SERVER)).toBeNull();
    expect(classifySenderUrl(`${SERVER}/`, null)).toBeNull();
    expect(originOf('app://desktop/settings/index.html')).toBe('app://desktop');
    expect(isLocalPage('app://desktop/settings/index.html', 'settings')).toBe(true);
  });

  it('every channel has an ACL and remote content cannot reach recorder/session or config channels', () => {
    for (const ch of Object.values(CH)) {
      if (ch.startsWith('evt:')) continue;
      expect(CHANNEL_ACL[ch], ch).toBeDefined();
      if (ch.startsWith('local:')) expect(CHANNEL_ACL[ch], ch).not.toContain('web');
    }
    expect(CHANNEL_ACL[CH.recData]).toEqual(['recorder']);
    expect(CHANNEL_ACL[CH.configSet]).toEqual(['settings']);
  });
});

describe('app:// asset mapping', () => {
  it('serves only known page assets without traversal', () => {
    expect(localAssetPath('app://desktop/recorder/index.html')).toBe('recorder/index.html');
    expect(localAssetPath('app://desktop/common/common.css')).toBe('common/common.css');
    expect(localAssetPath('app://desktop/recorder/../../main.cjs')).toBeNull(); // URL parser collapses → main.cjs → not allowed dir
    expect(localAssetPath('app://desktop/recorder/%2e%2e/%2e%2e/main.cjs')).toBeNull();
    expect(localAssetPath('app://desktop/recorder/..%2f..%2fmain.cjs')).toBeNull();
    expect(localAssetPath('app://desktop/recorder/x%5C..%5Cmain.cjs')).toBeNull();
    expect(localAssetPath('app://desktop/main.cjs')).toBeNull();
    expect(localAssetPath('app://desktop/recorder/.env')).toBeNull();
    expect(localAssetPath('app://desktop/recorder/recorder.ts')).toBeNull();
    expect(localAssetPath('app://other/recorder/index.html')).toBeNull();
    expect(localAssetPath('https://desktop/recorder/index.html')).toBeNull();
  });
});
