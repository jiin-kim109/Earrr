import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { Database } from '../db/database.js';
import { AppError } from '../errors/app-error.js';

const limitSchema = z.object({
  usage: z.array(
    z.object({
      id: z.string(),
      at: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
    }),
  ),
  blockedUntil: z.number().int().nonnegative(),
  lease: z
    .object({
      id: z.string().uuid(),
      until: z.number().int().nonnegative(),
      callId: z.string().nullable(),
    })
    .nullable(),
});
type LimitState = z.infer<typeof limitSchema>;
const rowSchema = z.object({ revision: z.coerce.number().int().positive(), data: limitSchema });

export class VoiceLimitRepository {
  constructor(private readonly storage: Database | SupabaseClient) {}

  async change<T>(ip: string, change: (state: LimitState) => T): Promise<T> {
    if (this.storage instanceof Database) {
      const db = this.storage;
      return db.transaction(async () => {
        const row = await db
          .prepare('SELECT revision,data FROM earrr_voice_limits WHERE ip_key=?')
          .get(ip);
        const state = limitSchema.parse(
          row ? JSON.parse(String(row.data)) : { usage: [], blockedUntil: 0, lease: null },
        );
        const result = change(state);
        await db
          .prepare(
            `INSERT INTO earrr_voice_limits(ip_key,revision,data,updated_at) VALUES(?,?,?,?)
             ON CONFLICT(ip_key) DO UPDATE SET
               revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at`,
          )
          .run(ip, Number(row?.revision ?? 0) + 1, JSON.stringify(state), new Date().toISOString());
        return result;
      });
    }
    // Compare-and-swap keeps the same transition atomic across app workers.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await this.storage
        .from('earrr_voice_limits')
        .select('revision,data')
        .eq('ip_key', ip)
        .abortSignal(AbortSignal.timeout(5000))
        .maybeSingle();
      if (error) throw AppError.create('voice_limit_unavailable');
      const row = data ? rowSchema.parse(data) : null;
      const state: LimitState = row?.data ?? { usage: [], blockedUntil: 0, lease: null };
      const result = change(state);
      const saved = await this.storage
        .rpc('earrr_write_voice_limit', {
          subject_ip_key: ip,
          expected_revision: row?.revision ?? 0,
          next_data: state,
        })
        .abortSignal(AbortSignal.timeout(5000));
      if (saved.error) throw AppError.create('voice_limit_unavailable');
      if (saved.data === true) return result;
      if (saved.data !== false) throw AppError.create('voice_limit_unavailable');
    }
    throw AppError.create('voice_limit_unavailable');
  }
}
