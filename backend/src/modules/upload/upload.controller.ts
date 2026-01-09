import { FastifyReply, FastifyRequest } from 'fastify';
import { MultipartFile } from '@fastify/multipart';
import { UploadService } from './upload.service';
import type { UploadImageInput, UploadDocumentInput, DeleteFileInput } from './upload.schema';
import type { FileMetadata, UploadType } from './upload.types';

const uploadService = new UploadService();

export class UploadController {
  // Convert Fastify multipart file to FileMetadata
  private async parseMultipartFile(file: MultipartFile): Promise<FileMetadata> {
    const buffer = await file.toBuffer();
    
    return {
      fieldname: file.fieldname,
      originalFilename: file.filename,
      encoding: file.encoding,
      mimetype: file.mimetype,
      buffer,
      size: buffer.length,
    };
  }

  // Upload single image
  async uploadImage(request: FastifyRequest, reply: FastifyReply) {
    try {
      const parts = request.parts();
      let file: FileMetadata | null = null;
      let uploadType: string = 'listing_photo';
      let optimize = false;

      for await (const part of parts) {
        if (part.type === 'file') {
          file = await this.parseMultipartFile(part as MultipartFile);
        } else if (part.type === 'field') {
          if (part.fieldname === 'uploadType') {
            uploadType = part.value as string;
          } else if (part.fieldname === 'optimize') {
            optimize = part.value === 'true';
          }
        }
      }

      if (!file) {
        return reply.code(400).send({
          success: false,
          error: 'No file uploaded',
        });
      }

      const result = await uploadService.uploadImage(file, uploadType as UploadType, optimize);

      return reply.code(201).send({
        success: true,
        message: 'Image uploaded successfully',
        data: result,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Upload multiple images
  async uploadMultipleImages(request: FastifyRequest, reply: FastifyReply) {
    try {
      const parts = request.parts();
      const files: FileMetadata[] = [];
      let uploadType: any = 'listing_photo';
      let optimize = true;

      for await (const part of parts) {
        if (part.type === 'file') {
          const file = await this.parseMultipartFile(part as MultipartFile);
          files.push(file);
        } else {
          // Parse fields
          if (part.fieldname === 'uploadType') {
            uploadType = (part as any).value;
          }
          if (part.fieldname === 'optimize') {
            optimize = (part as any).value === 'true';
          }
        }
      }

      if (files.length === 0) {
        return reply.code(400).send({
          success: false,
          error: 'No files uploaded',
        });
      }

      if (files.length > 10) {
        return reply.code(400).send({
          success: false,
          error: 'Maximum 10 files allowed per upload',
        });
      }

      const results = await uploadService.uploadMultipleImages(files, uploadType, optimize);

      return reply.code(201).send({
        success: true,
        message: `${results.length} images uploaded successfully`,
        data: results,
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
    try {
      const parts = request.parts();
      let file: FileMetadata | null = null;
      let documentType: string = '';

      for await (const part of parts) {
        if (part.type === 'file') {
          file = await this.parseMultipartFile(part as MultipartFile);
        } else if (part.type === 'field') {
          if (part.fieldname === 'documentType') {
            documentType = part.value as string;
          }
        }
      }

      if (!file) {
        return reply.code(400).send({
          success: false,
          error: 'No file uploaded',
        });
      }

      if (!documentType) {
        return reply.code(400).send({
          success: false,
          error: 'Document type is required',
        });
      }

      const result = await uploadService.uploadDocument(file, 'vendor_document');

      // If user is authenticated, save document to vendor profile
      if (request.user) {
        const userId = (request.user as any).userId;
        // TODO: Save to vendor_documents table
        // This will be done in vendor service
      }

      return reply.code(201).send({
        success: true,
        message: 'Document uploaded successfully',
        data: { ...result, documentType },
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Delete file
  async deleteFile(
    request: FastifyRequest<{ Body: DeleteFileInput }>, 
    reply: FastifyReply
  ) {
    try {
      const { publicId, url } = request.body;

      if (!publicId && !url) {
        return reply.code(400).send({
          success: false,
          error: 'Either publicId or url is required',
        });
      }

      await uploadService.deleteFile(publicId, url);

      return reply.code(200).send({
        success: true,
        message: 'File deleted successfully',
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }
}