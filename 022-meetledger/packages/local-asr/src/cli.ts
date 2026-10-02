// CLI: model management and local transcription (explicit user actions only).
//   tsx packages/local-asr/src/cli.ts list
//   tsx packages/local-asr/src/cli.ts check    [--dir ./models] [model...]
//   tsx packages/local-asr/src/cli.ts download [--dir ./models] [model...]   (default: sense-voice diarization)
//   tsx packages/local-asr/src/cli.ts transcribe <16k-mono.wav> [--dir ./models] [--lang ja|en|auto] [--diarization]
// The transcript text is printed to stdout only (never logged elsewhere).
import { MODEL_CATALOG } from './catalog';
import { checkModels, downloadModel } from './models';
import { transcribeFile } from './transcribe';
import { sherpaStatus } from './sherpa';

function argValue(args: string[], flag: string, def: string): string {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1]) {
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  }
  return def;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift() ?? 'help';
  const dir = argValue(args, '--dir', process.env.LOCAL_ASR_MODEL_DIR ?? './models');
  switch (cmd) {
    case 'list':
      for (const m of MODEL_CATALOG) console.log(`${m.id}\t${(m.sizeBytes / 1e6).toFixed(1)} MB\t${m.title}\t${m.licenses.map((l) => l.license).join(' / ')}`);
      return;
    case 'check': {
      const ids = args.length ? args : MODEL_CATALOG.map((m) => m.id);
      const s = sherpaStatus();
      console.log(`sherpa-onnx-node: ${s.ok ? `ok (${s.version})` : `unavailable: ${s.reason}`}`);
      let ok = true;
      for (const id of ids) {
        const c = checkModels(dir, id);
        ok &&= c.ok;
        console.log(`${id}: ${c.ok ? 'ok' : `missing ${c.missing.join(', ')}`}`);
      }
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'download': {
      const ids = args.length ? args : ['sense-voice', 'diarization'];
      for (const id of ids) {
        let lastPct = -1;
        await downloadModel(id, dir, (p) => {
          if (p.phase === 'download') {
            const pct = Math.floor((p.receivedBytes / Math.max(1, p.totalBytes)) * 100);
            if (pct >= lastPct + 10) {
              lastPct = pct;
              process.stderr.write(`[${id}] ${pct}% ${p.url.split('/').pop()}\n`);
            }
          } else if (p.phase !== 'done') {
            lastPct = -1;
            process.stderr.write(`[${id}] ${p.phase} ${p.url.split('/').pop()}\n`);
          }
        });
        console.log(`${id}: ok`);
      }
      return;
    }
    case 'transcribe': {
      const lang = argValue(args, '--lang', 'auto');
      const diar = args.includes('--diarization');
      const wav = args.find((a) => !a.startsWith('--'));
      if (!wav) throw new Error('usage: transcribe <16k-mono.wav>');
      const t0 = Date.now();
      const r = await transcribeFile(wav, { modelDir: dir, language: lang, diarization: diar });
      console.log(JSON.stringify({ ...r, elapsedMs: Date.now() - t0 }, null, 2));
      return;
    }
    default:
      console.log('usage: cli.ts list | check [ids] | download [ids] | transcribe <wav> [--lang ja] [--diarization] [--dir ./models]');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
