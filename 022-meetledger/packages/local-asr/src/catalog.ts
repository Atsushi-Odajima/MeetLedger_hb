// Catalog of on-device models (sherpa-onnx). All downloads come from the official k2-fsa/sherpa-onnx GitHub releases.
// Models are only downloaded on explicit user action (CLI / desktop settings button); nothing is fetched implicitly.

export type ModelKind = 'asr' | 'diarization';

export interface ModelDownload {
  /** Official download URL (GitHub releases of k2-fsa/sherpa-onnx). */
  url: string;
  /** 'tar.bz2' archives are extracted into modelDir; 'file' downloads are stored as modelDir/<dest>. */
  type: 'tar.bz2' | 'file';
  /** For archives: the top-level directory the archive creates. For files: the file name. */
  dest: string;
  /** Expected download size in bytes (Content-Length measured 2026-10-02). */
  sizeBytes: number;
  /** Pinned SHA-256 of the downloaded file (verified before extraction). */
  sha256?: string;
}

export interface ModelLicense {
  component: string;
  license: string;
  url: string;
  /** Attribution text that must be shown in the app (About / licenses screen). */
  attribution?: string;
  commercialUse: 'allowed' | 'allowed-with-attribution' | 'unverified';
  notes?: string;
}

export interface ModelCatalogEntry {
  id: string;
  kind: ModelKind;
  title: string;
  description: string;
  languages: string[];
  downloads: ModelDownload[];
  /** role -> path relative to modelDir. Every path must exist for the model to be usable. */
  files: Record<string, string>;
  /** Approximate total download size in bytes. */
  sizeBytes: number;
  licenses: ModelLicense[];
}

const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const SENSE_VOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const PYANNOTE_DIR = 'sherpa-onnx-pyannote-segmentation-3-0';
const CAMPPLUS_FILE = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'sense-voice',
    kind: 'asr',
    title: 'SenseVoice Small (int8, 2024-07-17) + Silero VAD',
    description: '日本語・英語・中国語・韓国語・広東語に対応した軽量オフラインASR。VADで発話区間に分割して認識します。',
    languages: ['ja', 'en', 'zh', 'ko', 'yue'],
    downloads: [
      {
        url: `${GH}/asr-models/${SENSE_VOICE_DIR}.tar.bz2`,
        type: 'tar.bz2',
        dest: SENSE_VOICE_DIR,
        sizeBytes: 163_002_883,
        sha256: '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e',
      },
      { url: `${GH}/asr-models/silero_vad.onnx`, type: 'file', dest: 'silero_vad.onnx', sizeBytes: 643_854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' },
    ],
    files: {
      model: `${SENSE_VOICE_DIR}/model.int8.onnx`,
      tokens: `${SENSE_VOICE_DIR}/tokens.txt`,
      vad: 'silero_vad.onnx',
    },
    sizeBytes: 163_646_737,
    licenses: [
      {
        component: 'SenseVoiceSmall (iic/SenseVoiceSmall) weights',
        license: 'FunASR Model Open Source License Agreement v1.1',
        url: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
        attribution: 'SenseVoiceSmall © Alibaba Group (Tongyi Lab / FunAudioLLM). Licensed under the FunASR Model Open Source License v1.1. Converted to ONNX by k2-fsa/sherpa-onnx.',
        commercialUse: 'allowed-with-attribution',
        notes: '§2.2: 出典・作者情報・モデル名の表示が必須。ライセンス改訂が自動発効するため定期確認が必要。',
      },
      {
        component: 'Silero VAD',
        license: 'MIT (per snakers4/silero-vad repository; original text not re-verified in research)',
        url: 'https://github.com/snakers4/silero-vad',
        commercialUse: 'allowed',
      },
      { component: 'sherpa-onnx runtime', license: 'Apache-2.0', url: 'https://github.com/k2-fsa/sherpa-onnx', commercialUse: 'allowed' },
    ],
  },
  {
    id: 'diarization',
    kind: 'diarization',
    title: 'Speaker diarization: pyannote segmentation-3.0 + 3D-Speaker CAM++ (zh/en)',
    description: 'ローカル話者分離（Speaker 1/2…の区別のみ。声から実在人物を特定しません）。日本語会議での精度は未評価のため参考扱い。',
    languages: ['*'],
    downloads: [
      {
        url: `${GH}/speaker-segmentation-models/${PYANNOTE_DIR}.tar.bz2`,
        type: 'tar.bz2',
        dest: PYANNOTE_DIR,
        sizeBytes: 6_958_444,
        sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
      },
      { url: `${GH}/speaker-recongition-models/${CAMPPLUS_FILE}`, type: 'file', dest: CAMPPLUS_FILE, sizeBytes: 28_281_164, sha256: 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2' },
    ],
    files: {
      segmentation: `${PYANNOTE_DIR}/model.onnx`,
      embedding: CAMPPLUS_FILE,
    },
    sizeBytes: 35_239_608,
    licenses: [
      {
        component: 'pyannote segmentation-3.0',
        license: 'MIT (c) 2022 CNRS',
        url: 'https://github.com/pyannote/pyannote-audio',
        attribution: 'pyannote/segmentation-3.0 © 2022 CNRS (MIT License)',
        commercialUse: 'allowed',
        notes: '再配布時はLICENSEを同梱すること（アーカイブ内LICENSE）。',
      },
      {
        component: '3D-Speaker CAM++ (speech_campplus_sv_zh_en_16k-common_advanced)',
        license: 'Apache-2.0 (3D-Speaker repository). Individual ModelScope model card: unverified',
        url: 'https://github.com/modelscope/3D-Speaker',
        attribution: '3D-Speaker CAM++ © Alibaba (modelscope/3D-Speaker)',
        commercialUse: 'unverified',
        notes: '個別モデルカードのライセンス原文は未確認。販売前に法務確認が必要。',
      },
    ],
  },
];

export const DEFAULT_ASR_MODEL = 'sense-voice';
export const DIARIZATION_MODEL = 'diarization';

export function getModelEntry(id: string): ModelCatalogEntry {
  const e = MODEL_CATALOG.find((m) => m.id === id);
  if (!e) throw new Error(`Unknown local ASR model '${id}'. Known: ${MODEL_CATALOG.map((m) => m.id).join(', ')}`);
  return e;
}
