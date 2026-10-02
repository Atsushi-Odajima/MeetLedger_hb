import http from 'node:http';

export interface FakeRequest {
  method: string;
  path: string;
  bytes: number;
  at: number;
}

/**
 * A tiny OpenAI-compatible stand-in that only COUNTS what reaches it. The server under test is pointed at it via
 * OPENAI_BASE_URL, so any "external" transcription / LLM / embedding call becomes observable.
 */
export interface FakeExternal {
  url: string;
  requests: FakeRequest[];
  count(prefix?: string): number;
  reset(): void;
  close(): Promise<void>;
}

export interface FakeExternalOptions {
  /** Segments returned by POST /audio/transcriptions (diarized_json). */
  transcript?: { start: number; end: number; text: string; speaker?: string }[];
}

export async function startFakeExternal(opts: FakeExternalOptions = {}): Promise<FakeExternal> {
  const requests: FakeRequest[] = [];
  const transcript = opts.transcript ?? [
    { start: 0, end: 4, text: 'クラウド経由の文字起こしです。', speaker: 'A' },
    { start: 4, end: 8, text: '資料は来週までに作成します。', speaker: 'B' },
  ];
  const server = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => (bytes += c.length));
    req.on('end', () => {
      const path = (req.url ?? '/').replace(/\?.*$/, '').replace(/^\/v1/, '');
      requests.push({ method: req.method ?? 'GET', path, bytes, at: Date.now() });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (path.endsWith('/audio/transcriptions')) {
        return json(200, { language: 'ja', text: transcript.map((s) => s.text).join(''), segments: transcript });
      }
      if (path.endsWith('/embeddings')) {
        return json(200, { data: [{ index: 0, embedding: new Array(16).fill(0.1) }] });
      }
      // LLM calls: answer with a well-formed but deliberately unusable error so nothing fake ends up in the ledger.
      return json(503, { error: { message: 'fake external service (e2e)', type: 'server_error' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    count: (prefix) => requests.filter((r) => !prefix || r.path.startsWith(prefix)).length,
    reset: () => void requests.splice(0),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Env that enables every cloud provider of the installation and routes them to the fake. */
export function cloudEnv(fake: FakeExternal): Record<string, string> {
  return {
    OPENAI_BASE_URL: fake.url,
    OPENAI_API_KEY: 'sk-fake-e2e',
    CLOUD_TRANSCRIPTION_PROVIDER: 'openai',
    AI_PROVIDER: 'openai',
  };
}
