// Diarization helpers. Provider-side diarization (sherpa-onnx pyannote+CAM++, OpenAI diarize, Deepgram) yields
// anonymous clusters; channel-based separation uses the stereo capture (ch0 = mic, ch1 = system audio).
export { normalizeSpeakerLabels } from './labels';
export { MIC_SUGGESTION, REMOTE_SUGGESTION, channelRms, channelSpeakers, classifyByChannel, micSuggestionForClusters } from './channel';
export type { ChannelSide } from './channel';
