import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { AppError } from '../errors/app-error.js';
import type { Config } from '../config/environment.js';
import { z } from 'zod';

const cloudSave = z.object({
  revision: z.coerce.number().int().positive(),
  payload: z.string().min(1).max(8_000_000),
  imported_guest_id: z.string().uuid().nullable(),
});

export interface CloudSave {
  revision: number;
  payload: string;
  imported_guest_id: string | null;
}

export class CloudRepository {
  readonly client: SupabaseClient;
  private readonly identities = new Map<string, { user: User; until: number }>();
  constructor(config: Config) {
    if (!config.supabaseUrl || !config.supabaseServiceKey)
      throw new Error('Supabase server storage is not configured.');
    this.client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  async user(token: string): Promise<User> {
    const cached = this.identities.get(token);
    if (cached && cached.until > Date.now()) return cached.user;
    const { data, error } = await this.client.auth.getUser(token);
    if (error || !data.user) throw AppError.create('invalid_auth_session');
    if (!data.user.email_confirmed_at) throw AppError.create('email_verification_required');
    let expires: number;
    try {
      const claims: unknown = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
      );
      expires = z.object({ exp: z.number().int().positive() }).parse(claims).exp * 1000;
    } catch {
      throw AppError.create('invalid_auth_session');
    }
    if (expires <= Date.now()) throw AppError.create('invalid_auth_session');
    this.identities.set(token, { user: data.user, until: Math.min(Date.now() + 30_000, expires) });
    if (this.identities.size > 1000) this.identities.clear();
    return data.user;
  }
  async get(userId: string): Promise<CloudSave | null> {
    const { data, error } = await this.client
      .from('earrr_learning_saves')
      .select('revision,payload,imported_guest_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw AppError.create('cloud_storage_unavailable');
    return data ? cloudSave.parse(data) : null;
  }
  async put(
    userId: string,
    expectedRevision: number,
    payload: string,
    importedGuestId: string | null,
  ) {
    const { data, error } = await this.client.rpc('earrr_save_learning', {
      subject_user_id: userId,
      expected_revision: expectedRevision,
      next_payload: payload,
      guest_import_id: importedGuestId,
    });
    if (error) throw AppError.create('cloud_storage_unavailable');
    if (!data) throw AppError.create('cloud_save_conflict');
  }
}
