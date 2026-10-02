import { useState } from 'react';
import { Alert, Badge, Button, Card, KeyValue, Loading } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/hooks';
import { errorMessage } from '../../lib/api';

const WEB_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
export const NOTICES_URL = '/THIRD_PARTY_NOTICES.txt';

/**
 * Local speech models used for on-device / on-server transcription. Model names and attribution strings are kept
 * verbatim (the FunASR Model License requires crediting the source and keeping the model name).
 */
const MODELS: {
  id: string;
  name: string;
  purpose: 'asr' | 'vad' | 'segmentation' | 'embedding';
  holder: string;
  license: string;
  licenseUrl?: string;
  source: string;
  sourceUrl: string;
  attribution: string;
  verified: boolean;
}[] = [
  {
    id: 'sense-voice',
    name: 'SenseVoiceSmall (sherpa-onnx int8, 2024-07-17)',
    purpose: 'asr',
    holder: 'Alibaba Group (Tongyi Lab / FunAudioLLM)',
    license: 'FunASR Model Open Source License Agreement v1.1',
    licenseUrl: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
    source: 'FunAudioLLM/SenseVoice — ONNX conversion distributed via k2-fsa/sherpa-onnx releases',
    sourceUrl: 'https://github.com/FunAudioLLM/SenseVoice',
    attribution: 'SenseVoiceSmall © Alibaba Group (Tongyi Lab / FunAudioLLM). Licensed under the FunASR Model Open Source License v1.1. Converted to ONNX by k2-fsa/sherpa-onnx.',
    verified: true,
  },
  {
    id: 'silero-vad',
    name: 'Silero VAD (silero_vad.onnx)',
    purpose: 'vad',
    holder: 'Silero (snakers4/silero-vad)',
    license: 'MIT',
    source: 'snakers4/silero-vad — via k2-fsa/sherpa-onnx releases',
    sourceUrl: 'https://github.com/snakers4/silero-vad',
    attribution: 'Silero VAD © Silero Team (MIT License)',
    verified: false,
  },
  {
    id: 'pyannote',
    name: 'pyannote segmentation-3.0 (sherpa-onnx)',
    purpose: 'segmentation',
    holder: 'CNRS',
    license: 'MIT',
    source: 'pyannote/segmentation-3.0 — ONNX conversion via k2-fsa/sherpa-onnx releases',
    sourceUrl: 'https://huggingface.co/pyannote/segmentation-3.0',
    attribution: 'pyannote/segmentation-3.0 © 2022 CNRS (MIT License)',
    verified: true,
  },
  {
    id: '3d-speaker',
    name: '3D-Speaker CAM++ (speech_campplus_sv_zh_en_16k-common_advanced)',
    purpose: 'embedding',
    holder: 'Alibaba (modelscope/3D-Speaker)',
    license: '要確認 / To be confirmed',
    source: 'modelscope/3D-Speaker — ONNX via k2-fsa/sherpa-onnx releases',
    sourceUrl: 'https://github.com/modelscope/3D-Speaker',
    attribution: '3D-Speaker CAM++ © Alibaba (modelscope/3D-Speaker)',
    verified: false,
  },
];

function NoticesViewer() {
  const { t } = useI18n();
  const [state, setState] = useState<{ loading: boolean; text?: string; error?: string }>({ loading: false });
  const load = async () => {
    setState({ loading: true });
    try {
      const r = await fetch(NOTICES_URL, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setState({ loading: false, text: await r.text() });
    } catch (e) {
      setState({ loading: false, error: errorMessage(e) });
    }
  };
  return (
    <div className="stack">
      <div className="button-row">
        {!state.text && (
          <Button icon="file" onClick={load} loading={state.loading}>
            {t('about.showNotices')}
          </Button>
        )}
        <a className="btn btn-md btn-ghost" href={NOTICES_URL} target="_blank" rel="noopener noreferrer">
          <Icon name="link" size={16} />
          <span>{t('about.openNotices')}</span>
        </a>
      </div>
      {state.loading && <Loading />}
      {state.error && <Alert tone="warn">{t('about.noticesMissing', { error: state.error })}</Alert>}
      {state.text && (
        <pre className="notices-text" tabIndex={0} aria-label={t('about.thirdParty')}>
          {state.text}
        </pre>
      )}
    </div>
  );
}

export function AboutSettings() {
  const { t } = useI18n();
  const health = useApi<{ ok?: boolean; version?: string }>('/api/health');
  return (
    <div className="stack">
      <Card title={t('about.title')}>
        <KeyValue
          items={[
            { k: t('about.app'), v: 'MeetLedger' },
            { k: t('about.webVersion'), v: WEB_VERSION },
            { k: t('about.serverVersion'), v: health.data?.version ?? (health.loading ? '…' : '—') },
          ]}
        />
        <p className="field-hint">{t('brand.tagline')}</p>
      </Card>

      <Card title={t('about.models')}>
        <p className="field-hint">{t('about.modelsHint')}</p>
        <ul className="items">
          {MODELS.map((m) => (
            <li key={m.id} className="item license-item" data-testid={`model-${m.id}`}>
              <div className="item-main">
                <div className="item-title">
                  <span>{m.name}</span>
                  <Badge>{t(`about.purpose.${m.purpose}`)}</Badge>
                  {!m.verified && <Badge tone="warn">{t('about.unverified')}</Badge>}
                </div>
                <dl className="kv kv-compact">
                  <div className="kv-row">
                    <dt>{t('about.holder')}</dt>
                    <dd>{m.holder}</dd>
                  </div>
                  <div className="kv-row">
                    <dt>{t('about.license')}</dt>
                    <dd>
                      {m.licenseUrl ? (
                        <a href={m.licenseUrl} target="_blank" rel="noopener noreferrer">
                          {m.license}
                        </a>
                      ) : (
                        m.license
                      )}
                    </dd>
                  </div>
                  <div className="kv-row">
                    <dt>{t('about.source')}</dt>
                    <dd>
                      <a href={m.sourceUrl} target="_blank" rel="noopener noreferrer">
                        {m.source}
                      </a>
                    </dd>
                  </div>
                </dl>
                <p className="license-attribution">{m.attribution}</p>
              </div>
            </li>
          ))}
        </ul>
        <Alert tone="info">{t('about.voiceNote')}</Alert>
      </Card>

      <Card title={t('about.fonts')}>
        <ul className="items">
          <li className="item">
            <div className="item-main">
              <span className="item-title">Inter (Inter Display SemiBold, v4.1)</span>
              <span className="item-meta">Copyright (c) 2016 The Inter Project Authors · SIL Open Font License 1.1</span>
              <span className="field-hint">{t('about.interNote')}</span>
            </div>
          </li>
          <li className="item">
            <div className="item-main">
              <span className="item-title">Noto Sans JP (2.004)</span>
              <span className="item-meta">(c) 2014-2021 Adobe · SIL Open Font License 1.1</span>
              <span className="field-hint">{t('about.notoNote')}</span>
            </div>
          </li>
        </ul>
      </Card>

      <Card title={t('about.thirdParty')}>
        <p className="field-hint">{t('about.thirdPartyHint')}</p>
        <NoticesViewer />
      </Card>
    </div>
  );
}
