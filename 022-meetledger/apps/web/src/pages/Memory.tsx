import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, CachedNotice, EmptyState, ErrorView, Loading, PageHeader, TextField } from '../components/ui';
import { MemoryView, type MemoryDto } from '../components/MemoryView';
import { useI18n } from '../i18n';
import { useWs } from '../state/workspace';
import { qs } from '../lib/api';
import { useApi } from '../lib/hooks';

export function MemoryPage() {
  const { t } = useI18n();
  const { a } = useWs();
  const [params, setParams] = useSearchParams();
  const topic = params.get('topic') ?? '';
  const [text, setText] = useState(topic);
  const state = useApi<MemoryDto>(topic ? a(`/memory${qs({ topic })}`) : null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setParams(text.trim() ? { topic: text.trim() } : {});
  };
  return (
    <>
      <PageHeader title={t('nav.memory')} subtitle={t('memory.subtitle')} />
      <form className="inline-form" onSubmit={submit} role="search">
        <TextField label={t('memory.topic')} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('memory.placeholder')} />
        <Button type="submit" variant="primary" icon="search" disabled={!text.trim()}>
          {t('memory.search')}
        </Button>
      </form>
      {!topic ? (
        <EmptyState icon="memory" title={t('memory.start')} body={t('memory.startBody')} />
      ) : state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorView error={state.error} onRetry={state.reload} />
      ) : state.data ? (
        <>
          <CachedNotice at={state.cachedAt} />
          <MemoryView data={state.data} />
        </>
      ) : null}
    </>
  );
}
