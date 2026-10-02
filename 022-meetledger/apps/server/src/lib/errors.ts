export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg = 'Bad request', details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Forbidden') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'not_found', msg);
export const conflict = (msg = 'Conflict', details?: unknown) => new AppError(409, 'conflict', msg, details);
export const tooLarge = (msg = 'Payload too large') => new AppError(413, 'too_large', msg);
export const unsupported = (msg = 'Unsupported media type') => new AppError(415, 'unsupported_media', msg);
/** Raised when a privacy policy forbids an operation (e.g. external AI call for an AI-OFF meeting). */
export const policyDenied = (msg: string) => new AppError(403, 'policy_denied', msg);
