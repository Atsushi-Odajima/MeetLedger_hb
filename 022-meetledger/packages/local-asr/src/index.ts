// @meetledger/local-asr — on-device transcription & diarization (sherpa-onnx). Audio never leaves the machine.
// Public API (stable; also used by the Electron desktop companion):
//   MODEL_CATALOG, getModelEntry, checkModels, downloadModel, transcribeFile, localAsrAvailable,
//   sherpaStatus, setSherpaModule, readWavFile, wavPcmSha256, INAUDIBLE
export { MODEL_CATALOG, DEFAULT_ASR_MODEL, DIARIZATION_MODEL, getModelEntry } from './catalog';
export type { ModelCatalogEntry, ModelDownload, ModelKind, ModelLicense } from './catalog';
export { checkModels, downloadModel } from './models';
export type { DownloadOptions, DownloadProgress, ModelCheck } from './models';
export { sherpaStatus, setSherpaModule } from './sherpa';
export { decodeWav, parseWavHeader, readWavFile, wavPcmSha256 } from './wav';
export type { DecodedWav, WavInfo } from './wav';
export { INAUDIBLE, assignSpeakers, isUnintelligible, localAsrAvailable, transcribeFile, transcribeSamples } from './transcribe';
export type { DiarizationOptions, LocalSegment, LocalTranscriptionResult, TranscribeOptions } from './transcribe';
