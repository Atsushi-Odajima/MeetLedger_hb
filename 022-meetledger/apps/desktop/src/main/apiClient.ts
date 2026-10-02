// Allow-listed MeetLedger API calls made by the main process on behalf of the desktop recorder page.
// Requests use the SAME Chromium session (cookie `ml_sid`) as the main window, so the user logs in once in the
// web app. Non-GET requests carry the per-session CSRF token (`x-csrf-token` from GET /api/me) and the server
// origin as Origin header, exactly like the web app. Paths are built only from validated UUIDs — no passthrough.

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface MeetingSummary {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  consentState: string;
  transcriptionMode: string;
  isConfidential: boolean;
  aiEnabled: boolean;
  scheduledStart: string | null;
  startedAt: string | null;
  language: string | null;
}

export interface MeSummary {
  userName: string;
  workspaces: { id: string; name: string; role: string; isSample: boolean }[];
}

const MAX_JSON_BYTES = 10 * 1024 * 1024;

function pickMeeting(m: Record<string, unknown>): MeetingSummary {
  const s = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    id: String(m.id ?? ''),
    workspaceId: String(m.workspaceId ?? ''),
    title: s(m.title) ?? '(無題)',
    status: s(m.status) ?? 'unknown',
    consentState: s(m.consentState) ?? 'pending',
    transcriptionMode: s(m.transcriptionMode) ?? 'local',
    isConfidential: m.isConfidential === true,
    aiEnabled: m.aiEnabled !== false,
    scheduledStart: s(m.scheduledStart),
    startedAt: s(m.startedAt),
    language: s(m.language),
  };
}

export class MeetLedgerApi {
  private csrf: string | null = null;
  private csrfOrigin: string | null = null;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly getOrigin: () => string | null,
    private readonly clientInfo: { appVersion: string; platform: string },
  ) {}

  private origin(): string {
    const o = this.getOrigin();
    if (!o) throw new ApiError('not_configured', 'サーバーURLが設定されていません', 0);
    return o;
  }

  private async raw(method: string, path: string, body?: { json?: unknown; form?: FormData }, retried = false): Promise<unknown> {
    const origin = this.origin();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') {
      if (!this.csrf || this.csrfOrigin !== origin) await this.refreshCsrf();
      headers['x-csrf-token'] = this.csrf!;
      headers.origin = origin;
    }
    let payload: BodyInit | undefined;
    if (body?.json !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body?.form) {
      payload = body.form;
    }
    let res: Response;
    try {
      res = await this.fetchFn(origin + path, { method, headers, body: payload, credentials: 'include', redirect: 'error', cache: 'no-store' });
    } catch (e) {
      throw new ApiError('network', `サーバーに接続できません: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), 0);
    }
    if (res.status === 403 && method !== 'GET' && !retried) {
      // session rotated (re-login) → CSRF token changed; refresh once
      this.csrf = null;
      return this.raw(method, path, body, true);
    }
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > MAX_JSON_BYTES) throw new ApiError('too_large', 'サーバー応答が大きすぎます', res.status);
    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) throw new ApiError('too_large', 'サーバー応答が大きすぎます', res.status);
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; details?: { code?: string } } } | null)?.error;
      const code = err?.details?.code ?? err?.code ?? `http_${res.status}`;
      let message = err?.message ?? `HTTP ${res.status}`;
      if (res.status === 401) message = 'メインウィンドウで MeetLedger にログインしてください';
      throw new ApiError(res.status === 401 ? 'unauthenticated' : code, String(message).slice(0, 500), res.status);
    }
    return data;
  }

  async refreshCsrf(): Promise<void> {
    const me = (await this.raw('GET', '/api/me')) as { csrfToken?: unknown } | null;
    if (!me || typeof me.csrfToken !== 'string' || !me.csrfToken) throw new ApiError('unauthenticated', 'メインウィンドウで MeetLedger にログインしてください', 401);
    this.csrf = me.csrfToken;
    this.csrfOrigin = this.origin();
  }

  async me(): Promise<MeSummary> {
    const me = (await this.raw('GET', '/api/me')) as Record<string, unknown> | null;
    if (!me || typeof me !== 'object') throw new ApiError('bad_response', 'サーバー応答が不正です', 200);
    if (typeof me.csrfToken === 'string') {
      this.csrf = me.csrfToken;
      this.csrfOrigin = this.origin();
    }
    const user = (me.user ?? {}) as Record<string, unknown>;
    const ws = Array.isArray(me.workspaces) ? (me.workspaces as Record<string, unknown>[]) : [];
    return {
      userName: typeof user.name === 'string' ? user.name : '',
      workspaces: ws.map((w) => ({ id: String(w.id), name: String(w.name ?? ''), role: String(w.role ?? ''), isSample: w.isSample === true })),
    };
  }

  async meetings(workspaceId: string): Promise<MeetingSummary[]> {
    const r = (await this.raw('GET', `/api/w/${workspaceId}/meetings?limit=50&order=desc`)) as { items?: unknown } | null;
    const items = Array.isArray(r?.items) ? (r!.items as Record<string, unknown>[]) : [];
    return items.map(pickMeeting);
  }

  async meeting(workspaceId: string, meetingId: string): Promise<MeetingSummary> {
    return pickMeeting((await this.raw('GET', `/api/w/${workspaceId}/meetings/${meetingId}`)) as Record<string, unknown>);
  }

  async createMeeting(workspaceId: string, title: string): Promise<MeetingSummary> {
    return pickMeeting((await this.raw('POST', `/api/w/${workspaceId}/meetings`, { json: { title, source: 'desktop_capture' } })) as Record<string, unknown>);
  }

  async recordConsent(workspaceId: string, meetingId: string, state: 'notified' | 'confirmed', method: string): Promise<void> {
    await this.raw('POST', `/api/w/${workspaceId}/meetings/${meetingId}/consent`, {
      json: { kind: 'recording', state, method, details: { client: 'desktop', appVersion: this.clientInfo.appVersion, platform: this.clientInfo.platform } },
    });
  }

  async start(workspaceId: string, meetingId: string): Promise<MeetingSummary> {
    return pickMeeting((await this.raw('POST', `/api/w/${workspaceId}/meetings/${meetingId}/start`, { json: { capture: 'desktop' } })) as Record<string, unknown>);
  }

  async end(workspaceId: string, meetingId: string, expectMedia: boolean): Promise<void> {
    await this.raw('POST', `/api/w/${workspaceId}/meetings/${meetingId}/end`, { json: { expectMedia } });
  }

  async postLocalTranscript(
    workspaceId: string,
    meetingId: string,
    payload: { provider: string; model: string; language: string; segments: unknown[] },
  ): Promise<unknown> {
    return this.raw('POST', `/api/w/${workspaceId}/meetings/${meetingId}/transcript/local`, { json: payload });
  }

  async uploadMedia(workspaceId: string, meetingId: string, file: Blob, filename: string): Promise<{ assetId?: string; jobId?: string }> {
    const form = new FormData();
    form.append('file', file, filename);
    return ((await this.raw('POST', `/api/w/${workspaceId}/meetings/${meetingId}/media`, { form })) ?? {}) as { assetId?: string; jobId?: string };
  }

  /** Connectivity check for the settings page (no cookies needed). */
  static async probeServer(fetchFn: FetchFn, origin: string): Promise<{ ok: boolean; detail: string }> {
    for (const p of ['/api/health', '/api/setup/status']) {
      try {
        const res = await fetchFn(origin + p, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', cache: 'no-store' });
        if (res.ok) {
          const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          if (j && typeof j === 'object') return { ok: true, detail: p === '/api/health' ? `MeetLedger ${String(j.version ?? '')}`.trim() : 'MeetLedger' };
        }
      } catch (e) {
        return { ok: false, detail: `接続できません: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    }
    return { ok: false, detail: 'MeetLedger サーバーの応答ではありません' };
  }
}
