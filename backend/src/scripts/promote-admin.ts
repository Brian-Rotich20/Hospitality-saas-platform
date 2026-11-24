// Operator CLI: promote an existing, email-verified user to admin.
//
//   npm run admin:promote -- user@example.com
//
// Replaces the removed unauthenticated POST /api/dev/seed-admin endpoint. Access to this
// script is gated by access to the deployment's DATABASE_URL, not by an HTTP route.
// It never creates accounts or sets passwords: the person signs up normally first.
import { eq } from 'drizzle-orm';
import { db, closeDatabase } from '../platform/database/client.js';
import { users } from '../platform/database/schema/users.js';

async function main(): Promise<number> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('Usage: npm run admin:promote -- <email>');
    return 2;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true, role: true, verified: true },
  });
  if (!user) {
    console.error('No user with that email. Ask them to sign up first.');
    return 1;
  }
  if (!user.verified) {
    console.error('User has not verified their email; refusing to promote.');
    return 1;
  }
  if (user.role === 'admin') {
    console.log('User is already an admin. Nothing changed.');
    return 0;
  }
  if (user.role === 'vendor') {
    console.error('User is a vendor. Use a separate account for administration.');
    return 1;
  }

  await db.update(users).set({ role: 'admin', updatedAt: new Date() }).where(eq(users.id, user.id));
  console.log(`Promoted user ${user.id} to admin.`);
  return 0;
}

main()
  .then(async (code) => { await closeDatabase(); process.exit(code); })
  .catch(async (err: unknown) => {
    console.error('promote-admin failed:', err instanceof Error ? err.message : err);
    await closeDatabase();
    process.exit(1);
  });
