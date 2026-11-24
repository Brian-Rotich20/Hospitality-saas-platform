// The OpenAPI document is generated from the real route schemas. These checks keep it
// complete (every operation tagged and present) and in sync with docs/api/openapi.json.
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getApp } from '../helpers/app.js';

interface Doc { paths: Record<string, Record<string, { tags?: string[] }>>; components?: { securitySchemes?: Record<string, unknown> } }

const operations = (d: Doc) => Object.entries(d.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();

describe('OpenAPI document', () => {
  it('is generated for every route, each operation is tagged, and the session cookie scheme is declared', async () => {
    const app = await getApp();
    const doc = app.swagger() as unknown as Doc;
    const ops = operations(doc);
    expect(ops.length).toBeGreaterThan(80);
    for (const [p, methods] of Object.entries(doc.paths)) {
      if (p.startsWith('/docs')) continue;
      for (const [m, op] of Object.entries(methods)) expect({ op: `${m} ${p}`, tagged: (op.tags ?? []).length > 0 }).toEqual({ op: `${m} ${p}`, tagged: true });
    }
    expect(doc.components?.securitySchemes).toHaveProperty('sessionCookie');
    // Business model: no booking payment endpoints exist.
    expect(ops.filter((o) => /booking/i.test(o) && /pay|charge|refund|payout/i.test(o))).toEqual([]);
    expect(ops.some((o) => o.includes('/payouts'))).toBe(false);
  });

  it('matches the committed docs/api/openapi.json (run `npm run openapi:export` after changing routes)', async () => {
    const app = await getApp();
    const live = operations(app.swagger() as unknown as Doc);
    const committed = operations(JSON.parse(await readFile(path.resolve('docs/api/openapi.json'), 'utf8')) as Doc);
    expect(committed).toEqual(live);
  });
});
