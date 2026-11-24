// Password reset through Better Auth's flow and the transactional outbox.
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import { call, db, json, makeAdmin, memoryMailer, signUp, type Actor } from '../helpers/app.js';
import { dispatchOutbox } from '../../src/modules/notifications/dispatcher.js';
import { outbox } from '../../src/platform/database/schema/platform.js';
import { verifications } from '../../src/platform/database/schema/auth.js';

const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-brand-new-passphrase-42';

async function drain() {
  while ((await dispatchOutbox(100)) > 0) { /* deliver everything due */ }
}

const requestReset = (email: string) => call('POST', '/api/auth/request-password-reset', { body: { email } });
const resetRows = (userId: string) => db.select().from(outbox).where(and(eq(outbox.topic, 'auth.password_reset'), sql`${outbox.payload}->>'userId' = ${userId}`));

/** Deliver pending reset emails and return the token from the latest one sent to `email`. */
async function tokenFromEmail(email: string): Promise<string> {
  await drain();
  const mail = [...memoryMailer.sent].reverse().find((m) => m.to === email && m.tag === 'auth.password_reset');
  const token = mail?.html.match(/\/auth\/reset-password\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error(`no reset email for ${email}`);
  return token;
}

const signIn = (email: string, password: string) => call('POST', '/api/auth/sign-in/email', { body: { email, password } });

describe('password reset', () => {
  let user: Actor;

  beforeAll(async () => {
    user = await signUp();
    await drain();
  });

  it('answers identically for known and unknown emails (no account enumeration)', async () => {
    const known = await requestReset(user.email);
    const unknown = await requestReset(`nobody-${randomUUID()}@test.linkmart.local`);
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(json(unknown)).toEqual(json(known));
    expect(json(known)).toMatchObject({ status: true });
  });

  it('queues one email per account per window, delivered through the outbox, with a frontend reset link', async () => {
    await requestReset(user.email); // second request in the same window
    expect(await resetRows(user.userId)).toHaveLength(1);
    const token = await tokenFromEmail(user.email);
    expect(token.length).toBeGreaterThanOrEqual(20);
    const mail = [...memoryMailer.sent].reverse().find((m) => m.to === user.email && m.tag === 'auth.password_reset')!;
    expect(mail.html).toContain('http://localhost:5173/auth/reset-password?token=');
    // Once delivered, the token is no longer kept in the outbox.
    const [row] = await resetRows(user.userId);
    expect(row!.processedAt).toBeTruthy();
    expect(JSON.stringify(row!.payload)).not.toContain(token);
  });

  it('resets the password with a valid token, signs out existing sessions, and the token works only once', async () => {
    const token = await tokenFromEmail(user.email);
    expect((await call('GET', '/api/users/me', { actor: user })).statusCode).toBe(200);

    const res = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: NEW_PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ status: true });

    expect((await call('GET', '/api/users/me', { actor: user })).statusCode).toBe(401); // old session revoked
    expect((await signIn(user.email, PASSWORD)).statusCode).toBe(401);
    expect((await signIn(user.email, NEW_PASSWORD)).statusCode).toBe(200);

    const reuse = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'yet-another-passphrase-7' } });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.body).toContain('INVALID_TOKEN');
    expect((await signIn(user.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('rejects an unknown token', async () => {
    const res = await call('POST', '/api/auth/reset-password', { body: { token: 'not-a-real-token-0000000000', newPassword: NEW_PASSWORD } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('INVALID_TOKEN');
  });

  it('rejects an expired token and leaves the password unchanged', async () => {
    const other = await signUp();
    await requestReset(other.email);
    const token = await tokenFromEmail(other.email);
    await db.update(verifications).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verifications.identifier, `reset-password:${token}`));
    const res = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: NEW_PASSWORD } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('INVALID_TOKEN');
    expect((await signIn(other.email, PASSWORD)).statusCode).toBe(200);
  });

  it('enforces the minimum password length', async () => {
    const other = await signUp();
    await requestReset(other.email);
    const token = await tokenFromEmail(other.email);
    const res = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'short' } });
    expect(res.statusCode).toBe(400);
    expect((await signIn(other.email, PASSWORD)).statusCode).toBe(200);
  });

  it('reset tokens expire after an hour', async () => {
    const other = await signUp();
    await requestReset(other.email);
    const [v] = await db.select().from(verifications).where(like(verifications.identifier, 'reset-password:%')).orderBy(sql`${verifications.createdAt} desc`).limit(1);
    const minutes = (v!.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(55);
    expect(minutes).toBeLessThanOrEqual(60);
  });

  it('administrators never see reset tokens in the operations API', async () => {
    const admin = await makeAdmin();
    const other = await signUp();
    await drain();
    await requestReset(other.email); // queued, not yet delivered
    const list = json(await call('GET', '/api/admin/operations/outbox?state=pending&topic=auth.password_reset&limit=100', { actor: admin })).data as { payload: unknown }[];
    expect(list.length).toBeGreaterThan(0);
    for (const r of list) expect(r.payload).toEqual({ redacted: true });
  });
});
