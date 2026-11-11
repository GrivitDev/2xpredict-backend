import { v2 as cloudinary } from 'cloudinary';
import type { ConfigService } from '@nestjs/config';

/**
 * Configure the shared Cloudinary SDK only after Nest has loaded application
 * configuration. Import-time process.env reads can run before ConfigModule has
 * loaded the .env file, leaving the SDK silently configured with empty values.
 */
export function configureCloudinary(config: ConfigService): boolean {
  const cloudName = config.get<string>('CLOUDINARY_CLOUD_NAME')?.trim();
  const apiKey = config.get<string>('CLOUDINARY_API_KEY')?.trim();
  const apiSecret = config.get<string>('CLOUDINARY_API_SECRET')?.trim();

  if (!cloudName || !apiKey || !apiSecret) return false;

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  return true;
}

export default cloudinary;
