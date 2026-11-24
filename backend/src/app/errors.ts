// Typed application errors. Services throw these; the global handler maps them to HTTP.
// `code` is a stable machine-readable string clients can branch on.

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) { super(422, 'VALIDATION_FAILED', message, details); }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') { super(401, 'UNAUTHENTICATED', message); }
}
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this', code = 'FORBIDDEN') { super(403, code, message); }
}
export class NotFoundError extends AppError {
  constructor(entity = 'Resource') { super(404, 'NOT_FOUND', `${entity} not found`); }
}
export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', details?: unknown) { super(409, code, message, details); }
}
export class ServiceUnavailableError extends AppError {
  constructor(message: string, code = 'SERVICE_UNAVAILABLE') { super(503, code, message); }
}
export class BadGatewayError extends AppError {
  constructor(message: string, code = 'UPSTREAM_ERROR') { super(502, code, message); }
}
