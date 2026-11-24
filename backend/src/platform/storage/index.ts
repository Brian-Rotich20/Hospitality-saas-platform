// Object storage adapters (Cloudinary default, S3 optional). Public images only:
// private documents are deliberately unsupported until there is a requirement for them.
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';

export interface StoredObject {
  publicId: string;
  url: string;
  bytes: number;
  mimeType: string;
  width?: number | undefined;
  height?: number | undefined;
}

export interface Storage {
  putPublicImage(buffer: Buffer, folder: string, key: string, mimeType: string): Promise<StoredObject>;
  delete(publicId: string): Promise<void>;
}

class CloudinaryStorage implements Storage {
  constructor() {
    if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
      throw new Error('Cloudinary is not configured');
    }
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  putPublicImage(buffer: Buffer, folder: string, key: string, mimeType: string): Promise<StoredObject> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: `linkmart/${folder}`, public_id: key, resource_type: 'image', overwrite: false },
        (error, result) => {
          if (error || !result) return reject(new Error(`upload failed: ${error?.message ?? 'no result'}`));
          resolve({ publicId: result.public_id, url: result.secure_url, bytes: result.bytes, mimeType, width: result.width, height: result.height });
        },
      );
      stream.end(buffer);
    });
  }

  async delete(publicId: string): Promise<void> {
    const res = (await cloudinary.uploader.destroy(publicId, { resource_type: 'image' })) as { result?: string };
    if (res.result !== 'ok' && res.result !== 'not found') throw new Error(`delete failed: ${res.result ?? 'unknown'}`);
  }
}

class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor() {
    if (!env.AWS_REGION || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_S3_BUCKET) {
      throw new Error('S3 is not configured');
    }
    this.bucket = env.AWS_S3_BUCKET;
    this.client = new S3Client({
      region: env.AWS_REGION,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    });
  }

  async putPublicImage(buffer: Buffer, folder: string, key: string, mimeType: string): Promise<StoredObject> {
    const objectKey = `${folder}/${key}`;
    // Public read is granted by bucket policy on the image prefix, not per-object ACLs.
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: buffer, ContentType: mimeType }));
    return { publicId: objectKey, url: `https://${this.bucket}.s3.${env.AWS_REGION}.amazonaws.com/${objectKey}`, bytes: buffer.length, mimeType };
  }

  async delete(publicId: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: publicId }));
  }
}

let instance: Storage | undefined;
/** Lazily created so the app boots (and tests run) without storage credentials. */
export function getStorage(): Storage {
  instance ??= env.STORAGE_PROVIDER === 's3' ? new S3Storage() : new CloudinaryStorage();
  return instance;
}

/** Test hook: substitute an in-memory storage. */
export function setStorage(s: Storage): void {
  instance = s;
}
