export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static unreachable(): ApiError {
    return new ApiError(
      'network_unavailable',
      'The local practice server could not be reached. Make sure it is running, then try again.',
      0,
    );
  }

  static response(body: unknown, status: number): ApiError {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
    const message =
      error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : 'The request could not be completed.';
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'request_failed';
    return new ApiError(code, message, status);
  }
}
