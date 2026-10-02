import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deriveKey } from '../lib/crypto';
import type { ObjectStorage, PutResult } from './types';

// File format: "MLE1" | iv(12) | ciphertext | tag(16). AES-256-GCM with a per-org key derived from MASTER_KEY.
const MAGIC = Buffer.from('MLE1');
const HEADER = MAGIC.length + 12;
const TAG = 16;

export class LocalEncryptedStorage implements ObjectStorage {
  readonly driver = 'local-encrypted';
  private root: string;
  constructor(
    rootDir: string,
    private masterKey: string,
  ) {
    this.root = resolve(rootDir);
  }

  private pathFor(key: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error('invalid storage key');
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }

  private keyFor(key: string): Buffer {
    const org = key.match(/^org\/([^/]+)\//)?.[1] ?? 'global';
    return deriveKey(this.masterKey, `storage:${org}`);
  }

  private async write(key: string, src: Readable): Promise<PutResult> {
    const dest = this.pathFor(key);
    await mkdir(dirname(dest), { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keyFor(key), iv);
    const hash = createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk, _e, cb) {
        size += chunk.length;
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const tmp = `${dest}.part-${randomBytes(4).toString('hex')}`;
    const out = createWriteStream(tmp);
    out.write(MAGIC);
    out.write(iv);
    await pipeline(src, tap, cipher, out, { end: false });
    await new Promise<void>((res, rej) => out.end(cipher.getAuthTag(), (e?: Error | null) => (e ? rej(e) : res())));
    const { rename } = await import('node:fs/promises');
    await rename(tmp, dest);
    return { key, size, sha256: hash.digest('hex') };
  }

  putFile(key: string, filePath: string) {
    return this.write(key, createReadStream(filePath));
  }
  putBuffer(key: string, data: Buffer) {
    return this.write(key, Readable.from([data]));
  }

  async getStream(key: string): Promise<Readable> {
    const p = this.pathFor(key);
    const { size } = await stat(p);
    const fh = await open(p, 'r');
    const header = Buffer.alloc(HEADER);
    const tag = Buffer.alloc(TAG);
    await fh.read(header, 0, HEADER, 0);
    await fh.read(tag, 0, TAG, size - TAG);
    await fh.close();
    if (!header.subarray(0, 4).equals(MAGIC)) throw new Error('not an encrypted object');
    const decipher = createDecipheriv('aes-256-gcm', this.keyFor(key), header.subarray(4));
    decipher.setAuthTag(tag);
    const out = new PassThrough();
    if (size - TAG - HEADER <= 0) {
      decipher.final();
      out.end();
      return out;
    }
    pipeline(createReadStream(p, { start: HEADER, end: size - TAG - 1 }), decipher, out).catch((e) => out.destroy(e));
    return out;
  }

  async getToFile(key: string, destPath: string) {
    await mkdir(dirname(destPath), { recursive: true });
    await pipeline(await this.getStream(key), createWriteStream(destPath));
  }

  async delete(key: string) {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string) {
    return existsSync(this.pathFor(key));
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.pathFor(prefix.replace(/\/$/, '') || 'org');
    if (!existsSync(base)) return [];
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (!e.name.includes('.part-')) out.push(relative(this.root, p).split(sep).join('/'));
      }
    };
    await walk(base);
    return out;
  }
}
