// One error handler for the whole API. Response shape for every failure:
//   { success: false, error: <human message>, code: <STABLE_CODE>, details?, requestId }
// `error` stays a string for compatibility with the existing frontend.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

interface PgLikeError { code?: string; constraint_name?: string; constraint?: string }

function pgError(err: unknown): PgLikeError | undefined {
  // drizzle wraps driver errors (DrizzleQueryError.cause); postgres.js errors carry `code`.
  let cur: unknown = err;
  for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
    const c = cur as PgLikeError & { cause?: unknown; name?: string };
    if (typeof c.code === 'string' && /^[0-9A-Z]{5}$/.test(c.code)) return c;
    cur = c.cause;
  }
  return undefined;
}

function send(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string, details?: unknown) {
  return reply.status(status).send({
    success: false,
    error: message,
    code,
    ...(details !== undefined && { details }),
    requestId: request.id,
  });
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => send(reply, request, 404, 'ROUTE_NOT_FOUND', 'Route not found'));

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, 'application error');
      return send(reply, request, error.statusCode, error.code, error.message, error.details);
    }

    const validation = (error as FastifyError).validation;
    if (Array.isArray(validation) && validation.length > 0) {
      // Request schema validation (Zod via fastify-type-provider-zod, or JSON schema).
      const details = validation.map((v) => ({ path: v.instancePath || '/', message: v.message ?? 'invalid' }));
      return send(reply, request, 422, 'VALIDATION_FAILED', 'Request validation failed', details);
    }
    if (error instanceof ZodError) {
      const details = error.issues.map((i) => ({ path: `/${i.path.join('/')}`, message: i.message }));
      return send(reply, request, 422, 'VALIDATION_FAILED', 'Request validation failed', details);
    }

    const pg = pgError(error);
    if (pg?.code) {
      switch (pg.code) {
        case '23505': return send(reply, request, 409, 'ALREADY_EXISTS', 'A record with these details already exists');
        case '23P01': return send(reply, request, 409, 'CONFLICTING_RECORD', 'This conflicts with an existing record');
        case '23503': return send(reply, request, 422, 'INVALID_REFERENCE', 'A referenced record does not exist');
        case '22P02': return send(reply, request, 400, 'INVALID_INPUT', 'Malformed identifier or value');
        case '57014': request.log.error({ err: error }, 'statement timeout'); return send(reply, request, 503, 'TIMEOUT', 'The request took too long');
        default: break;
      }
    }

    const status = (error as FastifyError).statusCode;
    if (status === 429) return send(reply, request, 429, 'RATE_LIMITED', 'Too many requests, slow down');
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Framework-level client errors (bad JSON, payload too large, unsupported media type).
      return send(reply, request, status, (error as FastifyError).code ?? 'BAD_REQUEST', error.message);
    }

    request.log.error({ err: error }, 'unhandled error');
    return send(reply, request, 500, 'INTERNAL_ERROR', 'Something went wrong. Quote the request id if you contact support.');
  });
}
