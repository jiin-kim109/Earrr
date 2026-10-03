import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { archiveSchema } from './archive.js';
import type { LearningArchive } from './archive.js';

const saveSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    archive: archiveSchema,
  })
  .strict();
export type SavedLearning = z.infer<typeof saveSchema>;

export class SaveCodec {
  private readonly key: Buffer;
  constructor(key: string) {
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32)
      throw new Error('LEARNING_SAVE_KEY must be a base64-encoded 32-byte key.');
  }
  seal(scope: string, save: SavedLearning): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`earrr:learning:v1:${scope}`));
    const serialized = JSON.stringify(saveSchema.parse(save));
    if (Buffer.byteLength(serialized) > 64_000_000) throw AppError.create('learning_storage_full');
    const payload = gzipSync(serialized);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const encoded = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
    if (encoded.length > 8_000_000) throw AppError.create('learning_storage_full');
    return encoded;
  }
  open(scope: string, encoded: string): SavedLearning {
    try {
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length < 29 || encoded.length > 8_000_000) throw new Error('Invalid save size.');
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`earrr:learning:v1:${scope}`));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const compressed = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      return saveSchema.parse(
        JSON.parse(gunzipSync(compressed, { maxOutputLength: 64_000_000 }).toString('utf8')),
      );
    } catch {
      throw AppError.create('invalid_learning_save');
    }
  }
  encode(scope: string, id: string, revision: number, archive: LearningArchive) {
    return this.seal(scope, { id, revision, archive });
  }
}
