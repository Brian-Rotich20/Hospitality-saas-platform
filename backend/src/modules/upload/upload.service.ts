import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, cloudinary } from '../../config/storage';
import { env, config } from '../../config/env';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { nanoid } from 'nanoid';
import type { UploadResult, FileMetadata, UploadType } from './upload.types';

export class UploadService {
  // Validate file type
  private async validateFile(buffer: Buffer, allowedTypes: string[]): Promise<string> {
    const fileType = await fileTypeFromBuffer(buffer);
    
    if (!fileType) {
      throw new Error('Unable to determine file type');
    }

    if (!allowedTypes.includes(fileType.mime)) {
      throw new Error(`Invalid file type. Allowed types: ${allowedTypes.join(', ')}`);
    }

    return fileType.mime;
  }

  // Optimize image
  private async optimizeImage(buffer: Buffer, maxWidth: number = 1920): Promise<Buffer> {
    return sharp(buffer)
      .resize(maxWidth, null, {
        withoutEnlargement: true,
        fit: 'inside',
      })
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();
  }

  // Generate unique file name
  private generateFileName(originalName: string, uploadType: UploadType): string {
    const ext = originalName.split('.').pop() || 'jpg';
    const uniqueId = nanoid(10);
    const timestamp = Date.now();
    return `${uploadType}/${timestamp}-${uniqueId}.${ext}`;
  }

  // Upload to Cloudinary
  private async uploadToCloudinary(
    buffer: Buffer,
    fileName: string,
    uploadType: UploadType,
    optimize: boolean = true
  ): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const uploadOptions = {
        folder: `hospitality-saas/${uploadType}`,
        public_id: fileName.split('/').pop()?.split('.')[0] || fileName,
        resource_type: 'auto' as const,
        ...(optimize && {
          transformation: [
            { width: 1920, crop: 'limit' as const },
            { quality: 'auto:good' },
            { fetch_format: 'auto' as const },
          ],
        }),
      };

      const uploadStream = cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) {
            reject(new Error(`Cloudinary upload failed: ${error.message}`));
          } else if (result) {
            resolve({
              url: result.secure_url,
              publicId: result.public_id,
              fileName: fileName,
              fileSize: result.bytes,
              mimeType: result.format,
              width: result.width,
              height: result.height,
            });
          }
        }
      );

      uploadStream.end(buffer);
    });
  }

  // Upload to S3
  private async uploadToS3(
    buffer: Buffer,
    fileName: string,
    mimeType: string
  ): Promise<UploadResult> {
    if (!s3Client) {
      throw new Error('S3 client not configured');
    }

    const command = new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET!,
      Key: fileName,
      Body: buffer,
      ContentType: mimeType,
      ACL: 'public-read',
    });

    await s3Client.send(command);

    const url = `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${fileName}`;

    return {
      url,
      fileName,
      fileSize: buffer.length,
      mimeType,
    };
  }

  // Upload image (listing photos, profile photos)
  async uploadImage(
    file: FileMetadata,
    uploadType: UploadType,
    optimize: boolean = true
  ): Promise<UploadResult> {
    // Validate file size
    if (file.size > config.maxFileSize) {
      throw new Error(`File size exceeds maximum allowed size of ${config.maxFileSize / 1024 / 1024}MB`);
    }

    // Validate file type
    const mimeType = await this.validateFile(file.buffer, config.allowedImageTypes);

    // Optimize image if requested
    let buffer = file.buffer;
    if (optimize) {
      buffer = await this.optimizeImage(buffer);
    }

    // Generate unique file name
    const fileName = this.generateFileName(file.originalFilename, uploadType);

    // Upload based on provider
    if (env.STORAGE_PROVIDER === 'cloudinary') {
      return this.uploadToCloudinary(buffer, fileName, uploadType, optimize);
    } else if (env.STORAGE_PROVIDER === 's3') {
      return this.uploadToS3(buffer, fileName, mimeType);
    }

    throw new Error('No storage provider configured');
  }

  // Upload document (vendor KYC documents)
  async uploadDocument(
    file: FileMetadata,
    uploadType: UploadType = 'vendor_document'
  ): Promise<UploadResult> {
    // Validate file size
    if (file.size > config.maxFileSize) {
      throw new Error(`File size exceeds maximum allowed size of ${config.maxFileSize / 1024 / 1024}MB`);
    }

    // Validate file type
    const mimeType = await this.validateFile(file.buffer, config.allowedDocumentTypes);

    // Generate unique file name
    const fileName = this.generateFileName(file.originalFilename, uploadType);

    // Upload based on provider (no optimization for documents)
    if (env.STORAGE_PROVIDER === 'cloudinary') {
      return this.uploadToCloudinary(file.buffer, fileName, uploadType, false);
    } else if (env.STORAGE_PROVIDER === 's3') {
      return this.uploadToS3(file.buffer, fileName, mimeType);
    }

    throw new Error('No storage provider configured');
  }

  // Delete file from Cloudinary
  private async deleteFromCloudinary(publicId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      cloudinary.uploader.destroy(publicId, (error, result) => {
        if (error) {
          reject(new Error(`Cloudinary delete failed: ${error.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  // Delete file from S3
  private async deleteFromS3(fileName: string): Promise<void> {
    if (!s3Client) {
      throw new Error('S3 client not configured');
    }

    const command = new DeleteObjectCommand({
      Bucket: env.AWS_S3_BUCKET!,
      Key: fileName,
    });

    await s3Client.send(command);
  }

  // Delete file
  async deleteFile(publicId?: string, url?: string): Promise<void> {
    if (env.STORAGE_PROVIDER === 'cloudinary' && publicId) {
      await this.deleteFromCloudinary(publicId);
    } else if (env.STORAGE_PROVIDER === 's3' && url) {
      // Extract file name from URL
      const fileName = url.split('/').slice(-2).join('/');
      await this.deleteFromS3(fileName);
    } else {
      throw new Error('Unable to delete file: missing publicId or URL');
    }
  }

  // Generate signed URL for private files (S3 only)
  async generateSignedUrl(fileName: string, expiresIn: number = 3600): Promise<string> {
    if (env.STORAGE_PROVIDER !== 's3' || !s3Client) {
      throw new Error('Signed URLs only available with S3');
    }

    const command = new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET!,
      Key: fileName,
    });

    return getSignedUrl(s3Client, command, { expiresIn });
  }

  // Upload multiple images
  async uploadMultipleImages(
    files: FileMetadata[],
    uploadType: UploadType,
    optimize: boolean = true
  ): Promise<UploadResult[]> {
    const uploadPromises = files.map(file => 
      this.uploadImage(file, uploadType, optimize)
    );

    return Promise.all(uploadPromises);
  }
}