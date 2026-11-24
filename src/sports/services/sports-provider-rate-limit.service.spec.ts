import { SportsProviderRateLimitService } from './sports-provider-rate-limit.service';

describe('SportsProviderRateLimitService provider quota calendars', () => {
  const service = new SportsProviderRateLimitService({} as any);

  it('uses the YouTube Pacific quota day rather than the Nigeria calendar day', () => {
    const dailyPeriod = (service as any).getDailyPeriod.bind(service);

    expect(dailyPeriod('youtube', new Date('2026-11-24T07:59:59.000Z'))).toBe(
      '2026-11-23',
    );
    expect(dailyPeriod('youtube', new Date('2026-11-24T08:00:00.000Z'))).toBe(
      '2026-11-24',
    );
  });

  it('resumes YouTube at midnight Pacific Time in the winter', () => {
    expect(
      service.getQuotaResumeAt(
        'youtube',
        'daily',
        new Date('2026-11-24T07:30:00.000Z'),
      ),
    ).toEqual(new Date('2026-11-24T08:00:00.000Z'));
  });

  it('handles the Pacific daylight-saving transition without a fixed UTC offset', () => {
    expect(
      service.getQuotaResumeAt(
        'youtube',
        'daily',
        new Date('2026-03-08T08:30:00.000Z'),
      ),
    ).toEqual(new Date('2026-03-09T07:00:00.000Z'));
  });

  it('keeps other providers on the existing Nigeria-time daily calendar', () => {
    const dailyPeriod = (service as any).getDailyPeriod.bind(service);

    expect(dailyPeriod('espn', new Date('2026-11-24T22:59:59.000Z'))).toBe(
      '2026-11-24',
    );
    expect(dailyPeriod('espn', new Date('2026-11-24T23:00:00.000Z'))).toBe(
      '2026-11-25',
    );
    expect(
      service.getQuotaResumeAt(
        'espn',
        'daily',
        new Date('2026-11-24T22:00:00.000Z'),
      ),
    ).toEqual(new Date('2026-11-24T23:00:00.000Z'));
  });
});


describe('SportsProviderRateLimitService provider quota blocking', () => {
  it('blocks the provider until reset without consuming the search request allowance', async () => {
    const updateOne = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) });
    const service = new SportsProviderRateLimitService({ updateOne } as any);
    jest.spyOn(service as any, 'ensurePeriodState').mockResolvedValue(undefined);

    await service.markProviderDailyQuotaBlocked('youtube');

    const update = updateOne.mock.calls[0][1];
    expect(update.$set).toHaveProperty('quotaBlockedUntil');
    expect(update.$set).not.toHaveProperty('dailyRequests');
    expect(update.$set.dailyTimeZone).toBe('America/Los_Angeles');
  });
});
