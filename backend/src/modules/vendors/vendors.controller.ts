import { FastifyRequest, FastifyReply } from 'fastify';
import { VendorService } from './vendors.service';
import type { 
  VendorApplicationInput, 
  PayoutDetailsInput,
  UpdateVendorInput,
  VendorReviewInput 
} from './vendors.schema';

const vendorService = new VendorService();

export class VendorController {
  // Apply as vendor
  async applyAsVendor(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as any; // vendorApplicationSchema shape
    try {
      const userId = (request.user as any).userId;
      const vendor = await vendorService.applyAsVendor(userId, body);

      return reply.code(201).send({
        success: true,
        message: 'Vendor application submitted successfully',
        data: vendor,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get my vendor profile
  async getMyProfile(request: FastifyRequest, reply: FastifyReply) {
    // request.user or other properties can be inferred at runtime
    try {
      const userId = (request.user as any).userId;
      const vendor = await vendorService.getVendorProfile(userId);

      return reply.code(200).send({
        success: true,
        data: vendor,
      });
    } catch (error: any) {
      return reply.code(404).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Update my vendor profile
  async updateMyProfile(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as any; // updateVendorSchema shape
    try {
      const userId = (request.user as any).userId;
      const vendor = await vendorService.updateVendorProfile(userId, body);

      return reply.code(200).send({
        success: true,
        message: 'Profile updated successfully',
        data: vendor,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Add payout details
  async addPayoutDetails(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as any; // payoutDetailsSchema shape
    try {
      const userId = (request.user as any).userId;
      const vendor = await vendorService.addPayoutDetails(userId, body);

      return reply.code(200).send({
        success: true,
        message: 'Payout details added successfully',
        data: vendor,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Upload document
  async uploadDocument(request: FastifyRequest, reply: FastifyReply) {
    const payload = request.body as any; // file payload / multipart
    try {
      const userId = (request.user as any).userId;
      
      // TODO: Implement file upload logic with multipart
      // This is a placeholder - you'll need to implement actual file upload
      const { documentType, documentUrl, fileName, fileSize } = payload;

      const document = await vendorService.uploadDocument(
        userId,
        documentType,
        documentUrl,
        fileName,
        fileSize
      );

      return reply.code(201).send({
        success: true,
        message: 'Document uploaded successfully',
        data: document,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get my documents
  async getMyDocuments(request: FastifyRequest, reply: FastifyReply) {
    // ...existing code...
    try {
      const userId = (request.user as any).userId;
      const documents = await vendorService.getVendorDocuments(userId);

      return reply.code(200).send({
        success: true,
        data: documents,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Admin: Get pending vendors
  async getPendingVendors(request: FastifyRequest, reply: FastifyReply) {
    // ...existing code...
    try {
      const vendors = await vendorService.getPendingVendors();

      return reply.code(200).send({
        success: true,
        data: vendors,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Admin: Get all vendors
  async getAllVendors(request: FastifyRequest, reply: FastifyReply) {
    const { status, businessType, limit, offset } = request.query as {
      status?: string;
      businessType?: string;
      limit?: string;
      offset?: string;
    };
    // parse ints if needed: const limitNum = limit ? Number(limit) : undefined;
    try {
      const filters: Record<string, any> = {};
      if (status) filters.status = status;
      if (businessType) filters.businessType = businessType;
      if (limit) filters.limit = parseInt(limit);
      if (offset) filters.offset = parseInt(offset);

      const vendors = await vendorService.getAllVendors(filters);

      return reply.code(200).send({
        success: true,
        data: vendors,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Admin: Get vendor by ID
  async getVendorById(request: FastifyRequest, reply: FastifyReply) {
    const { vendorId } = request.params as { vendorId: string };
    try {
      const vendor = await vendorService.getVendorById(vendorId);

      return reply.code(200).send({
        success: true,
        data: vendor,
      });
    } catch (error: any) {
      return reply.code(404).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Admin: Review vendor application
  async reviewVendor(request: FastifyRequest, reply: FastifyReply) {
    const { vendorId } = request.params as { vendorId: string };
    const body = request.body as any; // vendorReviewSchema shape
    try {
      const adminId = (request.user as any).userId;
      const vendor = await vendorService.reviewVendorApplication(
        vendorId,
        adminId,
        body
      );

      return reply.code(200).send({
        success: true,
        message: `Vendor ${body.status} successfully`,
        data: vendor,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Admin: Suspend vendor
  async suspendVendor(request: FastifyRequest, reply: FastifyReply) {
    const { vendorId } = request.params as { vendorId: string };
    const { reason } = request.body as { reason: string };
    try {
        const vendor = await vendorService.suspendVendor(vendorId, reason);

        return reply.code(200).send({
        success: true,
        message: 'Vendor suspended successfully',
        data: vendor,
        });
    } catch (error: any) {
        return reply.code(400).send({
        success: false,
        error: error.message,
        });
    }
    }
}