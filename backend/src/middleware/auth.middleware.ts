import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../config/database';
import { vendors } from '../db/schema';
import { eq } from 'drizzle-orm';

// ── authenticate ──────────────────────────────────────────────────────────────
// Verifies JWT access token — attaches decoded payload to request.user
// Payload contains: { userId, email, role, vendorId? }

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({
      success: false,
      error: 'Unauthorized — invalid or expired token',
    });
  }
}

// ── requireAdmin ──────────────────────────────────────────────────────────────

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  if (user.role !== 'admin') {
    return reply.code(403).send({
      success: false,
      error: 'Admin access required',
    });
  }
}

// ── requireVendor ─────────────────────────────────────────────────────────────
// Also attaches vendorId to request.user so controllers don't need a DB call

export async function requireVendor(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;

  if (user.role !== 'vendor' && user.role !== 'admin') {
    return reply.code(403).send({
      success: false,
      error: 'Vendor access required',
    });
  }

  // ✅ Attach vendorId if not already in token (e.g. role was just upgraded)
  if (!user.vendorId) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, user.userId),
      columns: { id: true, status: true },
    });

    if (!vendor) {
      return reply.code(403).send({
        success: false,
        error: 'Vendor profile not found — please complete your vendor application',
      });
    }

    if (vendor.status !== 'approved') {
      return reply.code(403).send({
        success: false,
        error: 'Your vendor account is pending approval',
      });
    }

    user.vendorId = vendor.id;
  }
}