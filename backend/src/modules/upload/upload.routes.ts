import { FastifyInstance } from 'fastify';
import { UploadController } from './upload.controller';

const uploadController = new UploadController();

export async function uploadRoutes(fastify: FastifyInstance) {
  // Upload single image
  fastify.post('/image', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Upload'],
      description: 'Upload single image (listing photo, profile photo)',
      consumes: ['multipart/form-data'],
    },
  }, uploadController.uploadImage.bind(uploadController));

  // Upload multiple images
  fastify.post('/images', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Upload'],
      description: 'Upload multiple images (max 10)',
      consumes: ['multipart/form-data'],
    },
  }, uploadController.uploadMultipleImages.bind(uploadController));

  // Upload document
  fastify.post('/document', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Upload'],
      description: 'Upload vendor document (KYC)',
      consumes: ['multipart/form-data'],
    },
  }, uploadController.uploadDocument.bind(uploadController));

  // Delete file
  fastify.delete<{
    Body: {
      publicId: string;
      url: string;
    };
  }>('/file', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Upload'],
      description: 'Delete uploaded file',
      body: {
        type: 'object',
        required: ['publicId', 'url'],
        properties: {
          publicId: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
  }, uploadController.deleteFile.bind(uploadController));
}