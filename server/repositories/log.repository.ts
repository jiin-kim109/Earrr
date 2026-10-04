import type { SupabaseClient } from '@supabase/supabase-js';
import type { LogRow } from '../types/logging.types.js';

export class LogRepository {
  constructor(private readonly client: SupabaseClient) {}
  async write(events: LogRow[]) {
    const { error } = await this.client
      .from('earrr_events')
      .upsert(events, { onConflict: 'id', ignoreDuplicates: true })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw new Error(`Telemetry storage rejected the batch (${error.code}).`);
  }
}
