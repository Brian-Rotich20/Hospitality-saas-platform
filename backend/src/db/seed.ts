import { db } from '../config/database';
import {
  users,
  vendors,
  listings,
  bookings,
  vendorDocuments,
} from './schema';
import { hashPassword } from '../utils/password';
import { sql } from 'drizzle-orm';
import { error } from 'console';

async function seed() {
  console.log('🌱 Starting database seeding...\n');

  try {
    // ==================== STEP 1: CREATE USERS ====================
    console.log('📝 Creating users...');

    // Admin User
    const adminPassword = await hashPassword('admin123');
    const [adminUser] = await db
      .insert(users)
      .values({
        email: 'admin2@hospitality.com',
        phone: '+255712345678',
        passwordHash: adminPassword,
        role: 'admin',
        verified: true,
      })
      .returning();
    if (!adminUser) throw new Error('Failed to create admin user');
    console.log('✅ Admin created:', adminUser.email);

    // Customer User 1
    const customerPassword = await hashPassword('customer123');
    const [customer1] = await db
      .insert(users)
      .values({
        email: 'john.doe@gmail.com',
        phone: '+254722111111',
        passwordHash: customerPassword,
        role: 'customer',
        verified: true,
      })
      .returning();
    if (!customer1) throw new Error('Failed to create customer 1');
    console.log('✅ Customer 1 created:', customer1.email);

    // Customer User 2
    const [customer2] = await db
      .insert(users)
      .values({
        email: 'jane.smith@gmail.com',
        phone: '+254722222222',
        passwordHash: customerPassword,
        role: 'customer',
        verified: true,
      })
      .returning();
    if (!customer2) throw new Error('Failed to create customer 2');
    console.log('✅ Customer 2 created:', customer2.email);

    // Vendor User 1
    const vendorPassword = await hashPassword('vendor123');
    const [vendor1User] = await db
      .insert(users)
      .values({
        email: 'vendorone@venues.com',
        phone: '+254723333333',
        passwordHash: vendorPassword,
        role: 'vendor',
        verified: true,
      })
      .returning();
      if (!vendor1User) throw new Error('Failed to create vendor 1 user');
    console.log('✅ Vendor 1 User created:', vendor1User.email);

    // Vendor User 2
    const [vendor2User] = await db
      .insert(users)
      .values({
        email: 'vendortwo@catering.com',
        phone: '+254724444444',
        passwordHash: vendorPassword,
        role: 'vendor',
        verified: true,
      })
      .returning();
    if(!vendor2User) throw new Error('Failed to create vendor 2 user');   
    console.log('✅ Vendor 2 User created:', vendor2User.email);

    // Vendor User 3
    const [vendor3User] = await db
      .insert(users)
      .values({
        email: 'vendorthree@accommodation.com',
        phone: '+254725555555',
        passwordHash: vendorPassword,
        role: 'vendor',
        verified: true,
      })
      .returning();
    if (!vendor3User) throw new Error ("Failed to create vendor 3 user");
    console.log('✅ Vendor 3 User created:', vendor3User.email);

    // ==================== STEP 2: CREATE VENDORS ====================
    console.log('\n🏢 Creating vendor profiles...');

    // Vendor 1 - Event Venue
    const [vendor1] = await db
      .insert(vendors)
      .values({
        userId: vendor1User.id,
        businessName: 'Elite Event Venues Nairobi',
        businessType: 'event_venue',
        businessRegistration: 'BRN/2023/001234',
        taxPin: 'A001234567B',
        phoneNumber: '+254723333333',
        location: 'Westlands, Nairobi',
        description:
          'Premium event venue in the heart of Nairobi. We offer world-class facilities for weddings, conferences, and corporate events.',
        payoutMethod: 'mpesa',
        mpesaNumber: '+254723333333',
        status: 'approved',
        approvedBy: adminUser.id,
        approvedAt: new Date(),
      })
      .returning();
      if (!vendor1) throw new Error('Failed to create vendor 1');
    console.log('✅ Vendor 1 (Event Venue) created:', vendor1.businessName);

    // Vendor 2 - Catering
    const [vendor2] = await db
      .insert(vendors)
      .values({
        userId: vendor2User.id,
        businessName: 'Taste of Kenya Catering',
        businessType: 'catering',
        businessRegistration: 'BRN/2023/001235',
        taxPin: 'A001234568B',
        phoneNumber: '+254724444444',
        location: 'Kilimani, Nairobi',
        description:
          'Award-winning catering service specializing in authentic Kenyan cuisine and international dishes.',
        payoutMethod: 'mpesa',
        mpesaNumber: '+254724444444',
        status: 'approved',
        approvedBy: adminUser.id,
        approvedAt: new Date(),
      })
      .returning();
    if (!vendor2) throw new Error('Failed to create vendor 2');
    console.log('✅ Vendor 2 (Catering) created:', vendor2.businessName);

    // Vendor 3 - Accommodation
    const [vendor3] = await db
      .insert(vendors)
      .values({
        userId: vendor3User.id,
        businessName: 'Serena Luxury Accommodations',
        businessType: 'accommodation',
        businessRegistration: 'BRN/2023/001236',
        taxPin: 'A001234569B',
        phoneNumber: '+254725555555',
        location: 'Karen, Nairobi',
        description:
          'Luxury accommodation with stunning views. Perfect for wedding guests and event attendees.',
        payoutMethod: 'bank_transfer',
        bankAccountName: 'Serena Luxury Accommodations Ltd',
        bankAccountNumber: '1234567890',
        bankName: 'Equity Bank Kenya',
        status: 'approved',
        approvedBy: adminUser.id,
        approvedAt: new Date(),
      })
      .returning();
    if (!vendor3) throw new Error('Failed to create vendor 3');
    console.log('✅ Vendor 3 (Accommodation) created:', vendor3.businessName);

    // ==================== STEP 3: CREATE LISTINGS ====================
    console.log('\n📋 Creating listings...');

    // Listing 1 - Event Venue
    const [listing1] = await db
      .insert(listings)
      .values({
        vendorId: vendor1.id,
        title: 'Elegant Wedding Venue with Garden',
        slug: 'elegant-wedding-venue-garden',
        description:
          'Beautiful venue with garden, indoor hall, and outdoor reception area. Accommodates up to 500 guests. Includes catering kitchen, parking, and modern facilities.',
        category: 'event_venue',
        location: 'Westlands, Nairobi',
        address: 'Mpesi Lane, Westlands, Nairobi',
        latitude: "-1.2661",
        longitude: "36.8029",
        capacity: 500,
        basePrice: "150000",
        photos: [
          'https://images.unsplash.com/photo-1519671482677-11fbb979b06e?w=800',
          'https://images.unsplash.com/photo-1519671482677-11fbb979b06e?w=800',
          'https://images.unsplash.com/photo-1519671482677-11fbb979b06e?w=800',
        ],
        amenities: [
          'Indoor AC Hall',
          'Garden Area',
          'Catering Kitchen',
          'Free Parking',
          'Restrooms',
          'Sound System',
          'Dance Floor',
        ],
        instantBooking: true,
        status: 'active',
      })
      .returning();
    if (!listing1) throw new Error('Failed to create listing 1');
    console.log('✅ Listing 1 (Wedding Venue) created:', listing1.title);

    // Listing 2 - Conference Venue
    const [listing2] = await db
      .insert(listings)
      .values({
        vendorId: vendor1.id,
        title: 'Corporate Conference Center',
        slug: 'corporate-conference-center',
        description:
          'State-of-the-art conference center with breakout rooms, projection facilities, and high-speed internet. Ideal for seminars, workshops, and corporate meetings.',
        category: 'event_venue',
        location: 'Nairobi CBD, Nairobi',
        address: 'University Way, Nairobi CBD',
        latitude: "-1.2889",
        longitude: "36.8231",
        capacity: 300,
        basePrice: "100000",
        photos: [
          'https://images.unsplash.com/photo-1552664730-d307ca884978?w=800',
          'https://images.unsplash.com/photo-1552664730-d307ca884978?w=800',
        ],
        amenities: [
          'Breakout Rooms',
          'Projectors',
          'High-speed WiFi',
          'AC',
          'Parking',
          'Catering Services',
        ],
        instantBooking: true,
        status: 'active',
      })
      .returning();
    if (!listing2) throw new Error('Failed to create listing 2');
    console.log('✅ Listing 2 (Conference Center) created:', listing2.title);

    // Listing 3 - Catering Service
    const [listing3] = await db
      .insert(listings)
      .values({
        vendorId: vendor2.id,
        title: 'Full Catering Service for Events',
        slug: 'full-catering-service-events',
        description:
          'Professional catering service with customizable menus. We provide authentic Kenyan cuisine, international dishes, and beverages. Service includes waiters and bar staff.',
        category: 'catering',
        location: 'Kilimani, Nairobi',
        address: 'Kilimani Avenue, Nairobi',
        latitude: "-1.3021",
        longitude: "36.7922",
        capacity: 800,
        basePrice: "5000",
        photos: [
          'https://images.unsplash.com/photo-1555939594-58d7cb561251?w=800',
          'https://images.unsplash.com/photo-1555939594-58d7cb561251?w=800',
        ],
        amenities:[
          'Professional Chefs',
          'Waiters',
          'Bar Staff',
          'Custom Menus',
          'Setup & Cleanup',
          'Hot & Cold Service',
        ],
        instantBooking: true,
        status: 'active',
      })
      .returning();
    if (!listing3) throw new Error('Failed to create listing 3');
    console.log('✅ Listing 3 (Catering) created:', listing3.title);

    // Listing 4 - Budget Catering
    const [listing4] = await db
      .insert(listings)
      .values({
        vendorId: vendor2.id,
        title: 'Budget-Friendly Catering Package',
        slug: 'budget-friendly-catering-package',
        description:
          'Affordable catering service perfect for smaller events. Includes basic menu, drinks, and simple setup.',
        category: 'catering',
        location: 'Kilimani, Nairobi',
        address: 'Kilimani Avenue, Nairobi',
        latitude: "-1.3021",
        longitude: "36.7922",
        capacity: 200,
        basePrice: "2000",
        photos: [
          'https://images.unsplash.com/photo-1535920527894-ab7bab5f0de1?w=800',
        ],
        amenities: [
          'Basic Menu',
          'Drinks',
          'Simple Setup',
          'Staff Included',
        ],
        instantBooking: true,
        status: 'active',
      })
      .returning();
    if (!listing4) throw new Error('Failed to create listing 4');
    console.log('✅ Listing 4 (Budget Catering) created:', listing4.title);

    // Listing 5 - Luxury Accommodation
    const [listing5] = await db
      .insert(listings)
      .values({
        vendorId: vendor3.id,
        title: 'Luxury Suite with Garden View',
        slug: 'luxury-suite-garden-view',
        description:
          'Premium accommodation with king-sized bed, en-suite bathroom, and private balcony overlooking beautiful gardens. Includes breakfast and airport transfers.',
        category: 'accommodation',
        location: 'Karen, Nairobi',
        address: 'Bogani Road, Karen, Nairobi',
        latitude: "-1.3597",
        longitude: "36.6674",
        capacity: 2,
        basePrice: "25000",
        photos: [
          'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=800',
          'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=800',
        ],
        amenities: [
          'King Bed',
          'En-suite',
          'Private Balcony',
          'Garden View',
          'Free WiFi',
          'Air Conditioning',
          'TV',
          'Complimentary Breakfast',
        ],
        instantBooking: true,
        status: 'active',
      })
      .returning();
    if (!listing5) throw new Error('Failed to create listing 5'); 
    console.log('✅ Listing 5 (Luxury Accommodation) created:', listing5.title);

    // Listing 6 - Standard Rooms
    const [listing6] = await db
      .insert(listings)
      .values({
        vendorId: vendor3.id,
        title: 'Standard Double Room',
        slug: 'standard-double-room',
        description:
          'Comfortable standard room with double bed, attached bathroom, and basic amenities. Good value for money with friendly service.',
        category: 'accommodation',
        location: 'Karen, Nairobi',
        address: 'Bogani Road, Karen, Nairobi',
        latitude: "-1.3597",
        longitude: "36.6674",
        capacity: 2,
        basePrice: "12000",
        photos: [
          'https://images.unsplash.com/photo-1566665556112-652023fba585?w=800',
        ],
        amenities: [
          'Double Bed',
          'Attached Bathroom',
          'WiFi',
          'AC',
          'TV',
          'Breakfast Included',
        ],
        instantBooking: true,
        status: 'active',
      })
      .returning();
    if (!listing6) throw new Error('Failed to create listing 6');
    console.log('✅ Listing 6 (Standard Room) created:', listing6.title);

    // ==================== STEP 4: CREATE BOOKINGS ====================
    console.log('\n📅 Creating bookings...');

    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 7);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 3);

    // Booking 1 - Confirmed
    const [booking1] = await db
      .insert(bookings)
      .values({
        listingId: listing1.id,
        customerId: customer1.id,
        startDate,
        endDate,
        guests: 150,
        baseAmount: "150000",
        platformFee: "15000",
        vat: "26400",
        totalAmount: "191400",
        status: 'confirmed',
        specialRequests: 'Please arrange for a live band for the reception.',
      })
      .returning();
    console.log('✅ Booking 1 (Wedding Venue - Confirmed) created');

    // Booking 2 - Pending
    const startDate2 = new Date();
    startDate2.setDate(startDate2.getDate() + 14);
    const endDate2 = new Date(startDate2);
    endDate2.setDate(endDate2.getDate() + 1);

    const [booking2] = await db
      .insert(bookings)
      .values({
        listingId: listing3.id,
        customerId: customer2.id,
        startDate: startDate2,
        endDate: endDate2,
        guests: 200,
        baseAmount: "1000000", // 200 guests * 5000 per person
        platformFee: "100000",
        vat: "176000",
        totalAmount: "1276000",
        status: 'pending',
        specialRequests: 'Vegetarian and vegan options needed for 50 guests.',
      })
      .returning();
    console.log('✅ Booking 2 (Catering - Pending) created');

    // Booking 3 - Completed
    const startDate3 = new Date();
    startDate3.setDate(startDate3.getDate() - 5);
    const endDate3 = new Date(startDate3);
    endDate3.setDate(endDate3.getDate() + 2);

    const [booking3] = await db
      .insert(bookings)
      .values({
        listingId: listing5.id,
        customerId: customer1.id,
        startDate: startDate3,
        endDate: endDate3,
        guests: 2,
        baseAmount: "75000",
        platformFee: "7500",
        vat: "13200",
        totalAmount: "95700",
        status: 'completed',
        specialRequests: 'Late checkout requested if possible.',
      })
      .returning();
    console.log('✅ Booking 3 (Accommodation - Completed) created');

    console.log('\n✅ Database seeding completed successfully!');
    console.log('\n📊 Summary:');
    console.log('- Users: 1 Admin, 2 Customers, 3 Vendors');
    console.log('- Vendors: 3 (1 Venue, 1 Catering, 1 Accommodation)');
    console.log('- Listings: 6 (2 Venues, 2 Catering, 2 Accommodation)');
    console.log('- Bookings: 3 (Confirmed, Pending, Completed)');

    console.log('\n🔐 Test Credentials:');
    console.log('\nAdmin:');
    console.log('  Email: admin@hospitality.com');
    console.log('  Password: admin123');
    console.log('\nCustomer 1:');
    console.log('  Email: john.doe@gmail.com');
    console.log('  Password: customer123');
    console.log('\nVendor 1 (Venues):');
    console.log('  Email: vendorone@venues.com');
    console.log('  Password: vendor123');
    console.log('\nVendor 2 (Catering):');
    console.log('  Email: vendortwo@catering.com');
    console.log('  Password: vendor123');
    console.log('\nVendor 3 (Accommodation):');
    console.log('  Email: vendorthree@accommodation.com');
    console.log('  Password: vendor123');

    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seed();