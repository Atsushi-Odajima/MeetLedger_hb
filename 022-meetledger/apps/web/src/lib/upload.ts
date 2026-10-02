// Multipart upload with progress (XHR — fetch has no upload progress events).
import { ApiError, NetworkError, api } from './api';

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort(): void;
}

export function uploadWithProgress<T = unknown>(
  url: string,
  file: Blob,
  filename: string,
  onProgress: (loaded: number, total: number) => void,
  fields: Record<string, string> = {},
): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const promise = (async () => {
    if (!api.getCsrf()) await api.refreshCsrf();
    return new Promise<T>((resolve, reject) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append('file', file, filename);
      xhr.open('POST', url);
      xhr.withCredentials = true;
      xhr.setRequestHeader('accept', 'application/json');
      const csrf = api.getCsrf();
      if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
      xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
      xhr.onload = () => {
        let data: unknown = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
        else {
          const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
          reject(new ApiError(xhr.status, err?.code ?? `http_${xhr.status}`, err?.message ?? 'Upload failed', err?.details));
        }
      };
      xhr.onerror = () => reject(new NetworkError());
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      xhr.send(form);
    });
  })();
  return { promise, abort: () => xhr.abort() };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
