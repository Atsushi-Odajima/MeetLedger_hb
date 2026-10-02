// Logging policy: never log audio, transcript text, notes, prompts, AI outputs, passwords, tokens or cookies.
// Fastify/pino redaction covers request objects; `safeMeta` strips content fields from ad-hoc metadata.

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.text',
  '*.body',
  '*.transcript',
  '*.notes',
  '*.prompt',
  '*.content',
  '*.quote',
];

const CONTENT_KEYS = new Set(['text', 'body', 'transcript', 'notes', 'prompt', 'content', 'quote', 'password', 'token', 'apiKey', 'secret', 'answer', 'question', 'description', 'segments']);

export function safeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return meta;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (CONTENT_KEYS.has(k)) out[k] = typeof v === 'string' ? `[redacted ${v.length} chars]` : '[redacted]';
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = safeMeta(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/** Truncate error messages from external providers which might echo request content. */
export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}
