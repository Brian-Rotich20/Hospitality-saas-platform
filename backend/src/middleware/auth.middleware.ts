import { FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../config/auth.js';
import { db } from '../config/database.js';
import { vendors } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    if (!session?.user) {
      return reply.code(401).send({
        success: false,
        error: 'Unauthorized — invalid or expired session',
      });
    }

    (request as any).user = {
      userId:        session.user.id,
      email:         session.user.email,
      role:          (session.user as any).role ?? 'customer',
      vendorId:      (session.user as any).vendorId,
      emailVerified: session.user.emailVerified,
    };
  } catch {
    return reply.code(401).send({
      success: false,
      error: 'Unauthorized — invalid or expired session',
    });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  if (user.role !== 'admin') {
    return reply.code(403).send({ success: false, error: 'Admin access required' });
  }
}

export async function requireVendor(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  if (user.role !== 'vendor' && user.role !== 'admin') {
    return reply.code(403).send({ success: false, error: 'Vendor access required' });
  }
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
    user.vendorId = vendor.id;
  }
}

export async function requireVerified(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  if (!user.emailVerified) {
    return reply.code(403).send({
      success: false,
      error: 'Please verify your email first',
      code: 'EMAIL_NOT_VERIFIED',
    });
  }
}