import { S3Client } from '@aws-sdk/client-s3';
import { v2 as cloudinary } from 'cloudinary';
import { env } from './env';

// AWS S3 Client
export const s3Client = env.STORAGE_PROVIDER === 's3' && env.AWS_ACCESS_KEY_ID
  ? new S3Client({
      region: env.AWS_REGION!,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      },
    })
  : null;

// Cloudinary Configuration
if (env.STORAGE_PROVIDER === 'cloudinary' && env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });
}

export { cloudinary };