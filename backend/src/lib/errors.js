// Application errors carry an HTTP status and a stable machine-readable code.
// The error-handler middleware turns them into { error: { code, message, details } }.

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(code, message, details) {
    super(409, code, message, details);
  }
}

export class UnprocessableError extends AppError {
  constructor(code, message, details) {
    super(422, code, message, details);
  }
}
