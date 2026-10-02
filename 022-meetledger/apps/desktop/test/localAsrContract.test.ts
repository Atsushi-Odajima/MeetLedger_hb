// Contract test against the real packages/local-asr (developed in parallel). Skipped when the package is absent.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogEntries, normalizeModel, normalizeProgress } from '../src/shared/models';

const catalogFile = path.resolve(__dirname, '../../../packages/local-asr/src/catalog.ts');
const indexFile = path.resolve(__dirname, '../../../packages/local-asr/src/index.ts');

describe.skipIf(!fs.existsSync(catalogFile))('packages/local-asr contract', () => {
  it('exports the functions the desktop worker calls', () => {
    const src = fs.readFileSync(indexFile, 'utf8');
    for (const name of ['MODEL_CATALOG', 'checkModels', 'downloadModel', 'transcribeFile']) expect(src, name).toContain(name);
  });

  it('every catalog model normalizes with size, license and attribution for the download dialog', async () => {
    const { MODEL_CATALOG } = await import(catalogFile);
    const models = catalogEntries(MODEL_CATALOG).map((e) => normalizeModel(e, false));
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m, 'id must be a safe model id').not.toBeNull();
      expect(m!.sizeBytes, `${m!.id} size`).toBeGreaterThan(0);
      expect(m!.license, `${m!.id} license`).not.toBe('不明');
      expect(m!.sourceUrl, `${m!.id} source`).toMatch(/^https:\/\//);
    }
    expect(models.some((m) => m!.diarization)).toBe(true);
    expect(models.some((m) => !m!.diarization && m!.languages.includes('ja'))).toBe(true);
    const sv = models.find((m) => m!.id === 'sense-voice');
    if (sv) expect(sv.attribution).toMatch(/SenseVoice/);
  });

  it('download progress objects ({phase, receivedBytes, totalBytes}) normalize', () => {
    expect(normalizeProgress('sense-voice', [{ modelId: 'sense-voice', url: 'u', phase: 'download', receivedBytes: 50, totalBytes: 100 }])).toEqual({
      id: 'sense-voice',
      receivedBytes: 50,
      totalBytes: 100,
      fraction: 0.5,
      phase: 'download',
    });
  });
});
