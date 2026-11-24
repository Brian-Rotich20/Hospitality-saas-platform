// Structured JSON logging (pino). The HTTP server and the worker share these options so
// log lines have one shape everywhere. Secrets in headers and known sensitive fields are
// redacted before serialisation.
import { pino, type LoggerOptions } from 'pino';
import { env } from './config/env.js';

export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'linkmart-api', env: env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-paystack-signature"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.secret',
      '*.authorizationCode',
      '*.authorization_code',
      '*.accessToken',
      '*.otp',
      '*.passkey',
      '*.consumerSecret',
      '*.mpesaNumber',
      '*.bankAccountNumber',
    ],
    censor: '[redacted]',
  },
};

/** Logger for code that runs outside a request (worker, jobs, scripts). */
export const logger = pino(loggerOptions);
export type Logger = typeof logger;
