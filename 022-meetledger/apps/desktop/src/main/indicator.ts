// Persistent "recording" indicator. Recording is never hidden: while a session is armed or recording,
//  - the recorder window stays visible, always on top, and cannot be minimized; closing it asks to stop first
//  - every window title starts with "● 録音中"
//  - the tray icon switches to a red dot with tooltip (where a tray is available)
//  - Windows taskbar overlay icon / macOS Dock badge show REC
// The OS adds its own indicators on top (macOS menu-bar mic/screen indicator, Windows mic privacy indicator).

import { app, BrowserWindow, Menu, Tray, nativeImage, type NativeImage } from 'electron';
import type { RecState } from '../shared/ipc';

function dot(size: number, rgba: [number, number, number, number]): NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size * 0.42;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, r - d + 0.5));
      const i = (y * size + x) * 4;
      // BGRA for createFromBitmap
      buf[i] = rgba[2];
      buf[i + 1] = rgba[1];
      buf[i + 2] = rgba[0];
      buf[i + 3] = Math.round(rgba[3] * a);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export interface IndicatorDeps {
  iconPath: string;
  windows: () => BrowserWindow[];
  recorderWindow: () => BrowserWindow | null;
  onOpenMain: () => void;
  onOpenRecorder: () => void;
  onQuit: () => void;
}

export class RecordingIndicator {
  private tray: Tray | null = null;
  private idleIcon: NativeImage | null = null;
  private recIcon = dot(32, [220, 38, 38, 255]);
  private state: RecState | null = null;

  constructor(private readonly deps: IndicatorDeps) {}

  initTray(): void {
    try {
      const img = nativeImage.createFromPath(this.deps.iconPath);
      this.idleIcon = img.isEmpty() ? dot(32, [37, 99, 235, 255]) : img.resize({ width: process.platform === 'darwin' ? 18 : 32 });
      this.tray = new Tray(this.idleIcon);
      this.tray.setToolTip('MeetLedger Desktop');
      this.tray.on('click', () => this.deps.onOpenMain());
      this.refreshMenu();
    } catch {
      this.tray = null; // e.g. Linux without a StatusNotifier host — indicator still shown in windows
    }
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const active = this.isActive();
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: active ? '● 録音中 — 録音ウィンドウを表示' : 'デスクトップ録音…', click: () => this.deps.onOpenRecorder() },
        { label: 'MeetLedger を開く', click: () => this.deps.onOpenMain() },
        { type: 'separator' },
        { label: '終了', click: () => this.deps.onQuit() },
      ]),
    );
  }

  isActive(): boolean {
    const p = this.state?.phase;
    return p === 'ready' || p === 'recording' || p === 'busy';
  }

  isRecording(): boolean {
    return this.state?.phase === 'recording';
  }

  private label(): string | null {
    const p = this.state?.phase;
    return p === 'recording' ? '● 録音中' : p === 'ready' ? '● 録音準備中' : p === 'busy' ? '● 録音処理中' : null;
  }

  /** Title decoration; also applied from 'page-title-updated' so the web page cannot remove it. */
  decorate(title: string): string {
    const base = title.replace(/^● 録音(中|準備中|処理中) — /, '');
    const label = this.label();
    return label ? `${label} — ${base}` : base;
  }

  update(state: RecState): void {
    const wasActive = this.isActive();
    this.state = state;
    const active = this.isActive();
    const label = this.label();

    for (const w of this.deps.windows()) {
      if (w.isDestroyed()) continue;
      w.setTitle(this.decorate(w.getTitle()));
      if (process.platform === 'win32') w.setOverlayIcon(active ? this.recIcon : null, active ? '録音中' : '');
    }
    const rec = this.deps.recorderWindow();
    if (rec && !rec.isDestroyed()) {
      if (active) {
        if (rec.isMinimized()) rec.restore();
        rec.show();
        rec.setAlwaysOnTop(true, 'floating');
        rec.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        rec.setMinimizable(false);
      } else {
        rec.setAlwaysOnTop(false);
        rec.setVisibleOnAllWorkspaces(false);
        rec.setMinimizable(true);
      }
    }
    if (process.platform === 'darwin') app.dock?.setBadge(active ? 'REC' : '');
    if (this.tray) {
      this.tray.setImage(active ? this.recIcon : (this.idleIcon ?? this.recIcon));
      this.tray.setToolTip(active ? `MeetLedger — ${label ?? '処理中'}: ${state.meetingTitle ?? ''}` : 'MeetLedger Desktop');
      if (wasActive !== active) this.refreshMenu();
    }
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
