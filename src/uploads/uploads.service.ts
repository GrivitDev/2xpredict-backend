import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cloudinary, { configureCloudinary } from './config/cloudinary.config';
import { UploadFolder } from './enums/upload-folder.enum';

@Injectable()
export class UploadsService {
  private readonly cloudinaryConfigured: boolean;

  constructor(config: ConfigService) {
    this.cloudinaryConfigured = configureCloudinary(config);
  }

  private async upload(file: Express.Multer.File, folder: UploadFolder) {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException('A valid uploaded file is required.');
    }
    return this.uploadBuffer(file.buffer, folder);
  }

  async uploadBuffer(
    buffer: Buffer,
    folder: UploadFolder,
  ): Promise<{
    url: string;
    publicId: string;
    width: number;
    height: number;
    format: string;
    bytes: number;
  }> {
    this.assertCloudinaryConfigured();
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new BadRequestException('The upload buffer is empty or invalid.');
    }

    return new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            folder,
            resource_type: 'image',
            transformation: [
              {
                width: 1200,
                crop: 'limit',
                quality: 'auto',
                fetch_format: 'auto',
              },
            ],
          },
          (error, result) => {
            if (error || !result) {
              return reject(error || new Error('Cloudinary upload failed'));
            }

            resolve({
              url: result.secure_url,
              publicId: result.public_id,
              width: result.width,
              height: result.height,
              format: result.format,
              bytes: result.bytes,
            });
          },
        )
        .end(buffer);
    });
  }

  async uploadAdImage(file: Express.Multer.File) {
    return this.upload(file, UploadFolder.ADS);
  }

  async uploadPredictionImage(file: Express.Multer.File) {
    return this.upload(file, UploadFolder.PREDICTIONS);
  }

  async uploadArticleImage(file: Express.Multer.File) {
    return this.upload(file, UploadFolder.ARTICLES);
  }

  async uploadPaymentProof(file: Express.Multer.File) {
    return this.upload(file, UploadFolder.PAYMENT_PROOFS);
  }

  async uploadUserAvatar(file: Express.Multer.File) {
    return this.upload(file, UploadFolder.USERS);
  }

  async uploadCommunityMedia(file: Express.Multer.File) {
    return this.upload(file, UploadFolder.COMMUNITY);
  }

  async deleteImage(publicId: string) {
    this.assertCloudinaryConfigured();
    const normalized = String(publicId ?? '').trim();
    if (!normalized || normalized.length > 255) {
      throw new BadRequestException('A valid Cloudinary public ID is required.');
    }
    return cloudinary.uploader.destroy(normalized, { resource_type: 'image' });
  }

  private assertCloudinaryConfigured(): void {
    if (!this.cloudinaryConfigured) {
      throw new ServiceUnavailableException(
        'Media uploads are unavailable because Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.',
      );
    }
  }
}
