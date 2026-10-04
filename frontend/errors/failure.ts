import { ApiError } from './api-error.js';

let handler: ((error: unknown) => void) | null = null;
export function onFatalError(callback: (error: unknown) => void) {
  handler = callback;
}
export function isFatalError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof ApiError) {
    return (
      error.status === 0 ||
      error.status >= 500 ||
      error.code.startsWith('azure_') ||
      [
        'guest_session_missing',
        'invalid_auth_session',
        'cloud_save_conflict',
        'invalid_learning_save',
      ].includes(error.code)
    );
  }
  return true;
}
export function reportFailure(error: unknown) {
  if (isFatalError(error)) handler?.(error);
}
