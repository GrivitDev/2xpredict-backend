import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const GEOLOCATION_REQUEST_TIMEOUT_MS = 1_500;

@Injectable()
export class GeoLocationService {
  private readonly logger = new Logger(GeoLocationService.name);

  async lookup(ip: string) {
    try {
      const normalizedIp = String(ip ?? '').trim();
      if (!normalizedIp) return null;

      // Ignore local development IPs.
      if (normalizedIp === '127.0.0.1' || normalizedIp === '::1') {
        return {
          country: 'Nigeria',
          countryCode: 'NG',
          city: 'Local Development',
        };
      }

      const response = await axios.get(
        `http://ip-api.com/json/${encodeURIComponent(normalizedIp)}?fields=status,country,countryCode,regionName,city,timezone,isp,org,lat,lon`,
        { timeout: GEOLOCATION_REQUEST_TIMEOUT_MS },
      );

      const data = response.data;

      if (data.status !== 'success') {
        return null;
      }

      return {
        country: data.country,

        countryCode: data.countryCode,

        region: data.regionName,

        city: data.city,

        timezone: data.timezone,

        isp: data.isp,

        organization: data.org,

        latitude: data.lat,

        longitude: data.lon,
      };
    } catch (error) {
      this.logger.warn(
        `IP location lookup failed or timed out: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

