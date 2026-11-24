// Outbound email. Brevo in staging/production; an in-memory transport for tests and an
// optional log-only transport for local development. Templates live in ./templates.ts
// and escape every interpolated value.
import { BrevoClient } from '@getbrevo/brevo';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  /** Stable tag for observability and tests, e.g. "booking.accepted". */
  tag: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

class BrevoMailer implements Mailer {
  private readonly client = new BrevoClient({ apiKey: env.BREVO_API_KEY ?? '' });
  async send(m: MailMessage): Promise<void> {
    try {
      await this.client.transactionalEmails.sendTransacEmail({
        sender: { name: env.MAIL_FROM_NAME, email: env.MAIL_FROM_EMAIL ?? '' },
        to: [{ email: m.to }],
        subject: m.subject,
        htmlContent: m.html,
        tags: [m.tag],
      });
    } catch (err) {
      // Never include the API key or full provider error body.
      throw new Error(`email send failed (${m.tag}): ${(err as Error).message}`);
    }
  }
}

/** Captures messages in memory. Used by tests (MAIL_TRANSPORT=memory). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  send(m: MailMessage): Promise<void> {
    this.sent.push(m);
    return Promise.resolve();
  }
  clear(): void {
    this.sent.length = 0;
  }
}

class LogMailer implements Mailer {
  send(m: MailMessage): Promise<void> {
    logger.info({ to: m.to, subject: m.subject, tag: m.tag }, 'email (log transport, not sent)');
    return Promise.resolve();
  }
}

export const memoryMailer = new MemoryMailer();

export const mailer: Mailer =
  env.MAIL_TRANSPORT === 'brevo' ? new BrevoMailer()
    : env.MAIL_TRANSPORT === 'memory' ? memoryMailer
      : new LogMailer();
