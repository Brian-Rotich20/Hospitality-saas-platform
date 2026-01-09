import { db } from '../config/database';
import { users } from './schema';
import { hashPassword } from '../utils/password';


async function seed() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const adminPassword = await hashPassword('admin123');
  const [admin] = await db.insert(users).values({
    email: 'admin@hospitality.com',
    phone: '+254712345678',
    passwordHash: adminPassword,
    role: 'admin',
    verified: true,
  }).returning();

  console.log('✅ Admin created:', admin?.email);

  // Create test customer
  const customerPassword = await hashPassword('customer123');
  const [customer] = await db.insert(users).values({
    email: 'customer@test.com',
    phone: '+254787654321',
    passwordHash: customerPassword,
    role: 'customer',
    verified: true,
  }).returning();

  console.log('✅ Customer created:', customer?.email);

  // Create test vendor user
  const vendorPassword = await hashPassword('vendor123');
  const [vendor] = await db.insert(users).values({
    email: 'vendor@test.com',
    phone: '+254723456789',
    passwordHash: vendorPassword,
    role: 'vendor',
    verified: true,
  }).returning();

  console.log('✅ Vendor created:', vendor?.email);

  console.log('✅ Seeding completed!');
  process.exit(0);
}

seed().catch((error) => {
  console.error('❌ Seed failed:', error);
  process.exit(1);
});