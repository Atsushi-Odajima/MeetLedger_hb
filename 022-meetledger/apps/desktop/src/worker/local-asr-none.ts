// Build-time stand-in used when packages/local-asr is not available/bundleable (scripts/build.mjs --local-asr=none).
// Exports nothing, so the worker's probe reports "local-asr 未実装" and the desktop keeps working without
// on-device transcription.
export {};
