import type { ModuleDef } from '../types';
import { AUDIO_PROCESS_JOB, processAudioJob } from './pipeline';
import audioRoutes from './routes';

// Audio module: upload/capture media, audio.process pipeline, transcripts (import / desktop-local / edit / versions),
// speaker mapping, signed media playback. See docs/AUDIO_PIPELINE.md and docs/TRANSCRIPTION.md.
const mod: ModuleDef = {
  name: 'audio',
  async routes(app, deps) {
    await audioRoutes(app, deps);
  },
  jobs(worker, deps) {
    worker.register(AUDIO_PROCESS_JOB, (job) => processAudioJob(deps, job));
  },
};
export default mod;

// Helpers other modules may use.
export { AUDIO_PROCESS_JOB, audioJobKey, chooseTranscriptionProvider, enqueueAudioProcess, localProviderId, processAudioJob } from './pipeline';
export { deleteMediaAsset, isPlayable, retentionUntil } from './retention';
export { signFileUrl, verifyFileSignature } from './signedUrl';
export { afterTranscriptWritten, loadTranscriptDto, listTranscriptVersions, prepareTranscript, writeTranscriptVersion } from './transcripts';
export { parseTranscriptImport } from './importers';
