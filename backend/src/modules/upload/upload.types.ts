export type UploadType = 'listing_photo' | 'vendor_document' | 'profile_photo';

export interface UploadResult {
  url: string;
  publicId?: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface FileMetadata {
  fieldname: string;
  originalFilename: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}