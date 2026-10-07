import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeedbackSubmission } from '../../shared/types/feedback.js';
import { Database } from '../db/database.js';
import { AppError } from '../errors/app-error.js';

export class FeedbackRepository {
  constructor(private readonly storage: Database | SupabaseClient) {}

  async save(actorId: string, sessionId: string | null, input: FeedbackSubmission) {
    const timestamp = new Date().toISOString();
    if (this.storage instanceof Database) {
      await this.storage
        .prepare(
          `INSERT INTO earrr_feedback
            (actor_id,session_id,rating,message,reply_email,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(actor_id) DO UPDATE SET
             session_id=excluded.session_id,rating=excluded.rating,
             message=excluded.message,reply_email=excluded.reply_email,
             updated_at=excluded.updated_at`,
        )
        .run(
          actorId,
          sessionId,
          input.rating,
          input.message,
          input.replyEmail,
          timestamp,
          timestamp,
        );
      return;
    }
    const { error } = await this.storage
      .from('earrr_feedback')
      .upsert(
        {
          actor_id: actorId,
          session_id: sessionId,
          rating: input.rating,
          message: input.message,
          reply_email: input.replyEmail,
          updated_at: timestamp,
        },
        { onConflict: 'actor_id' },
      )
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw AppError.create('feedback_storage_unavailable');
  }
}
