// Export the OpenAPI document generated from the live route schemas (Zod -> JSON Schema).
//   SWAGGER_ENABLED=true npm run openapi:export   -> docs/api/openapi.json
// Needs a syntactically valid environment but no running database or Redis: no query is
// executed. Never point it at production credentials; placeholders are enough.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../platform/config/env.js';
import { buildApp } from '../app/build-app.js';

async function main() {
  if (!env.SWAGGER_ENABLED) throw new Error('Set SWAGGER_ENABLED=true to export the OpenAPI document');
  const app = await buildApp();
  await app.ready();
  const doc = app.swagger() as { paths?: Record<string, unknown> };
  const out = path.resolve('docs/api/openapi.json');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.error(`wrote ${out} (${Object.keys(doc.paths ?? {}).length} paths)`);
  await app.close();
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
