import { FastifyReply, FastifyRequest } from 'fastify';

// Authenticate user
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    try {
        await request.jwtVerify();
    } catch (error) {
        return reply.code(401).send({
            success: false,
            error: 'Unauthorized - Invalid or expired token',
        });
    }
}

// Require admin role
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    const user = request.user as any;
    if (user.role !== 'admin') {
        return reply.code(403).send({
            success: false,
            error: 'Forbidden - Admin access required',
        });
    }
}
// Require vendor role
export async function requireVendor(request: FastifyRequest, reply: FastifyReply) {
    const user = request.user as any;
    if (user.role !== 'vendor' && user.role !== 'admin') {
        return reply.code(403).send({
            success: false,
            error: 'Forbidden - Vendor access required',
        });
    }
}