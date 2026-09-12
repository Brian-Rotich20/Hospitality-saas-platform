import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  try {
    console.log("Testing accounts INSERT...");

    const result = await sql`
      INSERT INTO accounts (
        id,
        user_id,
        account_id,
        provider_id,
        password,
        issuer,
        created_at,
        updated_at
      )
      VALUES (
        '650c6b05-e0b9-40c0-bac6-9aea2e049cb1',
        '98e79612-5725-478d-87ed-249347b2dddc',
        '98e79612-5725-478d-87ed-249347b2dddc',
        'credential',
        'dc17df61b09511f4f2abb5391ae530ee:7f07250efa57675a697aa96518028ad8cf278d6713f853fbb603a8f7cfe39ed0b61318b605a5cc19c485d20c8113c9e4ccac40572e641a82182eb20ba55d1425',
        'local:credential',
        '2026-08-20T04:44:20.887Z',
        '2026-08-20T04:44:20.887Z'
      )
      RETURNING *;
    `;

    console.log("SUCCESS:");
    console.dir(result, { depth: null });
  } catch (error: any) {
    console.error("\n========== DATABASE ERROR ==========");
    console.error("name:", error.name);
    console.error("message:", error.message);
    console.error("code:", error.code);
    console.error("detail:", error.detail);
    console.error("constraint:", error.constraint);
    console.error("table:", error.table);
    console.error("column:", error.column);
    console.error("schema:", error.schema);
    console.error("where:", error.where);
    console.error("hint:", error.hint);
    console.error("position:", error.position);
    console.error("routine:", error.routine);

    console.error("\nFULL ERROR:");
    console.dir(error, { depth: null });
  } finally {
    await sql.end();
  }
}

main();