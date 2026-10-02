import type { Readable } from 'node:stream';

export interface PutResult {
  key: string;
  size: number;
  sha256: string;
}

/** Object storage abstraction. Implementations: local encrypted filesystem (default), S3-compatible. */
export interface ObjectStorage {
  readonly driver: string;
  /** Stores a local file under key (encrypting at rest where supported). */
  putFile(key: string, filePath: string): Promise<PutResult>;
  putBuffer(key: string, data: Buffer): Promise<PutResult>;
  /** Decrypts into a readable stream. */
  getStream(key: string): Promise<Readable>;
  /** Decrypts into a local temp file and returns its path (caller deletes it). */
  getToFile(key: string, destPath: string): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}

/** Storage key layout keeps tenants separated: org/<orgId>/meeting/<meetingId>/<kind>/<id>. */
export function mediaKey(orgId: string, meetingId: string, kind: string, id: string) {
  return `org/${orgId}/meeting/${meetingId}/${kind}/${id}`;
}
