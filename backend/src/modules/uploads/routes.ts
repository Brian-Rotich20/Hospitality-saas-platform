// Image uploads (listing photos, vendor logos, profile photos). Each upload is recorded
// with its owner so deletion can be authorised. The real content type is detected from
// the bytes, images are re-encoded (stripping metadata and any embedded payload), and
// multipart limits are enforced by the parser before bytes are buffered.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { randomUUID } from 'node:crypto';
import { guards, requireUser } from '../../app/policies.js';
import { ok } from '../../app/http.js';
import { db } from '../../platform/database/client.js';
import { uploads } from '../../platform/database/schema/platform.js';
import { getStorage } from '../../platform/storage/index.js';
import { env } from '../../platform/config/env.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../app/errors.js';

const PURPOSES = ['listing_photo', 'vendor_logo', 'profile_photo'] as const;
type Purpose = (typeof PURPOSES)[number];

async function processImage(file: MultipartFile, ownerUserId: string, purpose: Purpose) {
  const buffer = await file.toBuffer(); // bounded by the multipart fileSize limit
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !env.ALLOWED_IMAGE_TYPES.includes(detected.mime)) {
    throw new ValidationError(`Unsupported file type. Allowed: ${env.ALLOWED_IMAGE_TYPES.join(', ')}`);
  }
  let output: Buffer;
  try {
    // WebP keeps transparency (the old pipeline flattened everything to JPEG).
    output = await sharp(buffer, { limitInputPixels: 40_000_000 }).rotate().resize(1920, 1920, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw new ValidationError('The image could not be processed');
  }
  const stored = await getStorage().putPublicImage(output, purpose, randomUUID(), 'image/webp');
  const [row] = await db.insert(uploads).values({
    ownerUserId, purpose, provider: env.STORAGE_PROVIDER, publicId: stored.publicId, url: stored.url, bytes: stored.bytes, mimeType: stored.mimeType,
  }).returning({ id: uploads.id, url: uploads.url, publicId: uploads.publicId, bytes: uploads.bytes, mimeType: uploads.mimeType });
  return { ...row, width: stored.width, height: stored.height };
}

function purposeAllowed(role: string, purpose: Purpose) {
  if ((purpose === 'listing_photo' || purpose === 'vendor_logo') && role !== 'vendor') {
    throw new ForbiddenError('Only vendors can upload listing photos and logos', 'VENDOR_REQUIRED');
  }
}

/** Mounted at /api/upload. */
export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  const handle = async (request: FastifyRequest, max: number) => {
    const authCtx = requireUser(request);
    let purpose: Purpose = 'listing_photo';
    const files: MultipartFile[] = [];
    const results = [];
    for await (const part of request.parts({ limits: { fileSize: env.MAX_FILE_SIZE, files: max, fields: 5 } })) {
      if (part.type === 'field') {
        if (part.fieldname === 'uploadType' || part.fieldname === 'purpose') {
          const p = z.enum(PURPOSES).safeParse(part.value);
          if (!p.success) throw new ValidationError(`uploadType must be one of ${PURPOSES.join(', ')}`);
          purpose = p.data;
        }
        continue;
      }
      purposeAllowed(authCtx.role, purpose);
      files.push(part);
      // Process each file as it arrives so at most one is buffered at a time.
      results.push(await processImage(part, authCtx.userId, purpose));
    }
    if (files.length === 0) throw new ValidationError('No file uploaded');
    return results;
  };

  app.post('/image', { preValidation: guards.user, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags: ['Upload'], consumes: ['multipart/form-data'] } },
    async (request, reply) => {
      const [result] = await handle(request, 1);
      reply.code(201);
      return ok(result, { message: 'Image uploaded' });
    });

  app.post('/images', { preValidation: guards.user, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['Upload'], consumes: ['multipart/form-data'] } },
    async (request, reply) => {
      const results = await handle(request, 10);
      reply.code(201);
      return ok(results, { message: `${results.length} images uploaded` });
    });

  // Owner (or admin) only. Previously any user could delete any asset.
  app.delete('/file', {
    preValidation: guards.user,
    schema: { tags: ['Upload'], body: z.object({ publicId: z.string().min(1).max(255) }) },
  }, async (request) => {
    const authCtx = requireUser(request);
    const row = await db.query.uploads.findFirst({ where: and(eq(uploads.publicId, request.body.publicId), isNull(uploads.deletedAt)) });
    if (!row || (row.ownerUserId !== authCtx.userId && authCtx.role !== 'admin')) throw new NotFoundError('File');
    await getStorage().delete(row.publicId);
    await db.update(uploads).set({ deletedAt: new Date() }).where(eq(uploads.id, row.id));
    return ok(null, { message: 'File deleted' });
  });
};
