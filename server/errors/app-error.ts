const definitions = {
  session_required: [400, 'Start or reconnect to a session before using this action.'],
  session_ended: [409, 'This session has ended. Start a new practice session.'],
  session_paused: [409, 'Practice is paused. Resume before playing or scoring an exercise.'],
  invalid_session_options: [
    400,
    'Guided introductions use the AI coach. Solo mode offers direct practice and labeled reference examples.',
  ],
  coach_required: [
    409,
    'Connect the coach to start a guided introduction. Solo practice keeps its existing question.',
  ],
  session_mode_conflict: [
    409,
    'End the current session before switching between coach and solo practice.',
  ],
  session_changed: [
    409,
    'The active lesson session has changed. Refresh before choosing a lesson.',
  ],
  session_not_found: [404, 'This session was not found.'],
  session_not_ready: [409, 'Start or resume an AI coach session before connecting audio.'],
  lesson_locked: [
    409,
    'Pass the previous lesson checkpoint to unlock this lesson. Previously completed lessons remain available for review.',
  ],
  lesson_change_required: [
    409,
    'Stay in the selected lesson. Use select_lesson only when the player explicitly chooses another unlocked lesson.',
  ],
  nothing_to_replay: [409, 'There is no previous exercise to replay yet.'],
  answer_not_found: [
    404,
    'That saved answer could not be found. Only scored answers are available for review.',
  ],
  round_in_progress: [
    409,
    'This round is still in progress. Resume its current question instead of starting another round.',
  ],
  round_choice_required: [
    409,
    'This round has ended. Choose whether to try again before playing another question.',
  ],
  round_changed: [409, 'The round changed while you were deciding. Review it and try again.'],
  invalid_learning_save: [
    422,
    'The saved progress could not be restored. It has not been deleted.',
  ],
  learning_storage_full: [
    507,
    'Progress exceeds the current storage limit. Existing progress has not been replaced.',
  ],
  invalid_auth_session: [
    401,
    'Your login session could not be verified. Log in again to load your saved progress.',
  ],
  email_verification_required: [403, 'Verify your email before saving progress to your account.'],
  guest_session_missing: [
    401,
    'The guest session expired. Reload to restore your locally saved progress.',
  ],
  cloud_storage_unavailable: [
    503,
    'Cloud progress could not be confirmed. Refresh before retrying; guest progress has not been deleted.',
  ],
  cloud_save_conflict: [
    409,
    'Progress changed in another tab or device. Refresh to load it before continuing.',
  ],
  account_progress_exists: [
    409,
    'This account already has learning progress. Guest progress has not been deleted.',
  ],
  demonstration_not_scored: [
    409,
    'This is a labeled teaching example, not a quiz. Do not score it. Explain the concept, replay a demonstration, or use start_practice if the player wants questions.',
  ],
  no_exercise: [409, 'No exercise is active. Ask the coach to play one.'],
  stale_exercise: [409, 'That answer belongs to a different exercise. Nothing was scored.'],
  stale_round: [
    409,
    'That question belongs to an earlier round. Nothing was scored. Play the current round question.',
  ],
  exercise_generation_failed: [503, 'A fresh exercise could not be selected. Try again.'],
  teaching_not_active: [409, 'There is no active introduction. Use teach_lesson to start one.'],
  unknown_teaching_step: [400, 'Choose a step ID from the selected lesson introduction.'],
  stale_teaching_step: [
    409,
    'The introduction changed. Use the current teaching state; do not advance an old demonstration.',
  ],
  stale_teaching_delivery: [
    409,
    'That teaching segment is no longer active. The current lesson is preserved.',
  ],
  playback_session_mismatch: [409, 'This playback does not belong to an open session.'],
  not_solo: [409, 'Natural conversation should be sent to the connected coach.'],
  solo_answer_unclear: [
    422,
    'Solo practice could not interpret that musical answer. Use a chord name, interval name, or the requested scale degrees. Connect the coach for natural conversation.',
  ],
  invalid_tool_arguments: [400, 'The tool arguments are invalid.'],
  call_id_reused: [409, 'This action identifier was already used with different arguments.'],
  reconnect_rate_limited: [
    429,
    'Too many connection attempts. Wait a minute, then reconnect; your practice is saved.',
  ],
  local_only: [403, 'Earrr is a local single-player app. Access it through localhost.'],
  cross_origin: [403, 'Cross-origin access to the local practice server is not allowed.'],
  client_header_required: [403, 'This action must come from the local Earrr app.'],
  route_not_found: [404, 'That local API route does not exist.'],
  azure_not_configured: [
    503,
    'Add the Azure resource endpoint and key to the server .env file, then restart. Solo practice is available without AI.',
  ],
  azure_session_invalid: [
    502,
    'Azure returned an unexpected session response. No credentials were sent to the browser.',
  ],
  azure_sdp_invalid: [502, 'Azure did not return a valid audio connection. Try reconnecting.'],
  invalid_request: [400, 'The request is invalid.'],
  invalid_json: [400, 'The request could not be read. Reload the app and retry.'],
  connection_timeout: [
    504,
    'The audio connection timed out. Check your connection and retry. Your current question is saved.',
  ],
  server_error: [
    500,
    'The local server could not complete this action. Check the server terminal and retry; no success was recorded.',
  ],
} as const;

export type ErrorCode = keyof typeof definitions;

export const diagnosticCodes = [
  'voice_playback_blocked',
  'audio_output_failed',
  'microphone_unavailable',
  'connection_lost',
] as const;

const providerMessages: Record<number, string> = {
  401: 'Azure rejected the server credential. Check AZURE_OPENAI_API_KEY in .env, then restart the server.',
  403: 'Azure denied access to this deployment. Check its access policy and resource permissions.',
  404: 'Azure could not find the realtime deployment or endpoint. Check the names in .env.',
  429: 'The Azure realtime deployment is at capacity. Wait a moment, then reconnect. Your exercise is saved.',
};

export class AppError extends Error {
  private constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static create(code: ErrorCode, detail?: string): AppError {
    const [status, message] = definitions[code];
    return new AppError(status, code, detail ?? message);
  }

  static provider(status: number, detail?: string): AppError {
    const message =
      providerMessages[status] ??
      `Azure could not start the coach.${detail ? ` ${detail}` : ' Check your realtime deployment configuration.'}`;
    return new AppError(status === 429 ? 429 : 502, `azure_${status}`, message);
  }
}
