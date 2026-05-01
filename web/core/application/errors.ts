/**
 * Error types use cases can throw. Driving adapters (route handlers) map
 * these to HTTP status codes; CLI adapters could map them to exit codes.
 *
 * Use cases never construct raw `Error` for known failure modes — they
 * throw one of these so the routing layer can produce the right response
 * shape without sniffing strings.
 */

export class NotFoundError extends Error {
  readonly kind = 'not_found';
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  readonly kind = 'validation';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AuthRequiredError extends Error {
  readonly kind = 'auth_required';
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}
