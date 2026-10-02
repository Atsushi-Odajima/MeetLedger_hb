import { z } from 'zod';

// All runtime configuration comes from environment variables (see .env.example).
// Secrets are never logged; `describeConfig` prints a redacted view.

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: int(8787),
  /** Public origin of the web app, used for CSRF origin checks, cookies, links in emails, OAuth redirects. */
  APP_ORIGIN: z.string().default('http://localhost:8787'),
  DATABASE_URL: z.string().default('postgres://meetledger:meetledger@127.0.0.1:5432/meetledger'),
  /** 32+ byte secret used for HMAC (signed URLs, CSRF). */
  SESSION_SECRET: z.string().min(32).default('dev-only-session-secret-change-me-0123456789'),
  /** base64 32-byte key for AES-256-GCM encryption of media, connector tokens and secrets. */
  MASTER_KEY: z.string().default('ZGV2LW9ubHktbWFzdGVyLWtleS1jaGFuZ2UtbWUtMzI='),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./.data/storage'),
  TMP_DIR: z.string().default('./.data/tmp'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  MAX_UPLOAD_MB: int(1024),
  SIGNED_URL_TTL_SEC: int(300),
  SESSION_TTL_HOURS: int(24 * 14),
  COOKIE_SECURE: bool(false),
  ALLOW_SIGNUP: bool(false),
  TRUST_PROXY: bool(false),
  LOG_LEVEL: z.string().default('info'),
  RUN_WORKER: bool(true),
  WORKER_CONCURRENCY: int(2),
  WORKER_POLL_MS: int(1000),
  SCHEDULER_INTERVAL_SEC: int(300),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  WEB_DIST_DIR: z.string().default('../web/dist'),
  // --- Transcription ---
  /** Allowed cloud transcription provider for this installation (none disables cloud transcription entirely). */
  CLOUD_TRANSCRIPTION_PROVIDER: z.enum(['none', 'openai', 'deepgram']).default('none'),
  LOCAL_ASR_MODEL_DIR: z.string().default('./models'),
  LOCAL_ASR_MODEL: z.string().default('sense-voice'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-4o-transcribe-diarize'),
  DEEPGRAM_API_KEY: z.string().optional(),
  // --- AI ---
  /** Allowed AI provider for summaries / extraction / ask. 'local-rules' never leaves the server. */
  AI_PROVIDER: z.enum(['local-rules', 'ollama', 'openai', 'anthropic']).default('local-rules'),
  AI_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  EMBEDDING_PROVIDER: z.enum(['local-hash', 'openai', 'ollama']).default('local-hash'),
  // --- Email ---
  EMAIL_DRIVER: z.enum(['outbox', 'smtp']).default('outbox'),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default('MeetLedger <no-reply@localhost>'),
  // --- Connectors ---
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default('common'),
  // --- Sample workspace ---
  SAMPLE_WORKSPACE: bool(true),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<Config> = {}): Config {
  const parsed = schema.parse(env);
  const cfg = { ...parsed, ...overrides };
  if (cfg.NODE_ENV === 'production') {
    if (cfg.SESSION_SECRET.startsWith('dev-only')) throw new Error('SESSION_SECRET must be set in production');
    if (cfg.MASTER_KEY === schema.shape.MASTER_KEY.parse(undefined)) throw new Error('MASTER_KEY must be set in production');
  }
  const key = Buffer.from(cfg.MASTER_KEY, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY must be base64 encoded 32 bytes');
  return cfg;
}

const SECRET_KEYS = /(SECRET|KEY|PASSWORD|TOKEN|SMTP_URL|DATABASE_URL)/;

export function describeConfig(cfg: Config): Record<string, unknown> {
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, SECRET_KEYS.test(k) && v ? '***' : v]));
}
