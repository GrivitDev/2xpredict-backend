import axios from 'axios';
import { GeoLocationService } from './geo-location.service';

describe('GeoLocationService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns local development metadata without making an external request', async () => {
    const getSpy = jest.spyOn(axios, 'get');
    const service = new GeoLocationService();
    await expect(service.lookup('127.0.0.1')).resolves.toEqual({
      country: 'Nigeria',
      countryCode: 'NG',
      city: 'Local Development',
    });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('sets a short request timeout and degrades to null on provider failure', async () => {
    const getSpy = jest.spyOn(axios, 'get').mockRejectedValue(new Error('timeout'));
    const service = new GeoLocationService();
    await expect(service.lookup('8.8.8.8')).resolves.toBeNull();
    expect(getSpy.mock.calls[0][1]).toEqual({ timeout: 1_500 });
  });

  it('returns normalized location data only for a successful provider response', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        status: 'success', country: 'Nigeria', countryCode: 'NG',
        regionName: 'FCT', city: 'Abuja', timezone: 'Africa/Lagos',
        isp: 'Example ISP', org: 'Example Org', lat: 9.0, lon: 7.4,
      },
    } as any);
    const service = new GeoLocationService();
    await expect(service.lookup('8.8.4.4')).resolves.toEqual(expect.objectContaining({
      country: 'Nigeria', countryCode: 'NG', region: 'FCT', city: 'Abuja',
    }));
  });
});
