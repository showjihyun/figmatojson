/**
 * HTTP error mapper for use-case exceptions.
 *
 * Domain layer throws typed errors (NotFoundError, ValidationError,
 * AuthRequiredError). Routes call `toHttpError(c, err)` to produce the
 * matching JSON response — keeps every handler's catch block one line.
 */

import type { Context } from 'hono';
import {
  AuthRequiredError,
  NotFoundError,
  ValidationError,
} from '../../../../core/application/errors.js';

export function toHttpError(c: Context, err: unknown): Response {
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
  if (err instanceof AuthRequiredError) return c.json({ error: err.message }, 401);
  return c.json({ error: (err as Error).message }, 500);
}
