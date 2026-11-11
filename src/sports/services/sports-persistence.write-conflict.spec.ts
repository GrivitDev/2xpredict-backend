import { SportsPersistenceService } from './sports-persistence.service';

describe('SportsPersistenceService transaction write-conflict retry', () => {
  it('retries the complete transaction on a MongoDB WriteConflict', async () => {
    jest.useFakeTimers();
    const service = Object.create(SportsPersistenceService.prototype) as SportsPersistenceService;
    const session = {
      withTransaction: jest.fn()
        .mockRejectedValueOnce({ code: 112, codeName: 'WriteConflict' })
        .mockResolvedValueOnce('committed'),
    };

    const pending = (service as any).withWriteConflictRetry(session, async () => 'work');
    await jest.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe('committed');
    expect(session.withTransaction).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('does not retry a non-transient transaction error', async () => {
    const service = Object.create(SportsPersistenceService.prototype) as SportsPersistenceService;
    const failure = { code: 121, codeName: 'DocumentValidationFailure' };
    const session = { withTransaction: jest.fn().mockRejectedValue(failure) };

    await expect(
      (service as any).withWriteConflictRetry(session, async () => 'work'),
    ).rejects.toBe(failure);
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
  });
});
