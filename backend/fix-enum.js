const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://hospitality_db_r6mm_user:M5CLi3md327NJy6qmKpffVGW3BqwpPHm@dpg-d7jmhe3bc2fs73c3hsbg-a.oregon-postgres.render.com/hospitality_db_r6mm?sslmode=require',
});

async function run() {
  await client.connect();
  console.log('✅ Connected to Render DB');

  // Add the missing enum value
  await client.query(
    "ALTER TYPE vendor_status ADD VALUE IF NOT EXISTS 'pending_verification' BEFORE 'pending'"
  );
  console.log('✅ Enum value added');

  // Confirm all values
  const result = await client.query(
    'SELECT unnest(enum_range(NULL::vendor_status)) AS value'
  );
  console.log('✅ Current enum values:');
  result.rows.forEach(r => console.log('  -', r.value));

  await client.end();
  console.log('Done.');
}

run().catch(e => {
  console.error('❌ Error:', e.message);
  client.end();
});