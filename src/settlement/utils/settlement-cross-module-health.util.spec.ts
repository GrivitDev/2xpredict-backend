import { collectSettlementCrossModuleHealth } from './settlement-cross-module-health.util';

describe('settlement cross-module health contract', () => {
  it('reports all upstream modules as healthy when each module snapshot is healthy', () => {
    const lookup = jest.fn((moduleName: string) => ({
      status: 'HEALTHY',
      checkedAt: new Date('2026-11-10T10:00:00.000Z'),
      moduleName,
    }));

    const result = collectSettlementCrossModuleHealth(lookup);

    expect(result.status).toBe('HEALTHY');
    expect(result.modules).toEqual({
      sports: { status: 'HEALTHY', checkedAt: '2026-11-10T10:00:00.000Z' },
      odds: { status: 'HEALTHY', checkedAt: '2026-11-10T10:00:00.000Z' },
      predictionsEngine: { status: 'HEALTHY', checkedAt: '2026-11-10T10:00:00.000Z' },
      betLab: { status: 'HEALTHY', checkedAt: '2026-11-10T10:00:00.000Z' },
    });
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('marks the upstream pipeline degraded and identifies a degraded consumer', () => {
    const result = collectSettlementCrossModuleHealth((moduleName) => ({
      status: moduleName === 'odds' ? 'DEGRADED' : 'HEALTHY',
    }));

    expect(result.status).toBe('DEGRADED');
    expect(result.alerts).toEqual([
      expect.objectContaining({
        code: 'ODDS_MODULE_DEGRADED',
        severity: 'WARNING',
      }),
    ]);
  });

  it('marks a failed source module as critical', () => {
    const result = collectSettlementCrossModuleHealth((moduleName) => ({
      status: moduleName === 'sports' ? 'FAILED' : 'HEALTHY',
    }));

    expect(result.status).toBe('CRITICAL');
    expect(result.alerts).toEqual([
      expect.objectContaining({
        code: 'SPORTS_MODULE_CRITICAL',
        severity: 'CRITICAL',
      }),
    ]);
  });

  it('preserves UNKNOWN instead of treating a missing module snapshot as healthy', () => {
    const result = collectSettlementCrossModuleHealth((moduleName) =>
      moduleName === 'sports' ? { status: 'HEALTHY' } : undefined,
    );

    expect(result.status).toBe('UNKNOWN');
    expect(result.modules.odds.status).toBe('UNKNOWN');
    expect(result.alerts).toHaveLength(0);
  });


  it('normalizes the BetLab OK status into the shared HEALTHY contract', () => {
    const result = collectSettlementCrossModuleHealth((moduleName) => ({
      status: moduleName === 'bet-lab' ? 'OK' : 'HEALTHY',
    }));

    expect(result.status).toBe('HEALTHY');
    expect(result.modules.betLab.status).toBe('HEALTHY');
    expect(result.alerts).toHaveLength(0);
  });

  it('normalizes warning and partial aliases to DEGRADED', () => {
    const result = collectSettlementCrossModuleHealth((moduleName) => ({
      status: moduleName === 'odds' ? 'WARNING' :
        moduleName === 'bet-lab' ? 'PARTIAL' : 'HEALTHY',
    }));

    expect(result.status).toBe('DEGRADED');
    expect(result.modules.odds.status).toBe('DEGRADED');
    expect(result.modules.betLab.status).toBe('DEGRADED');
    expect(result.alerts).toHaveLength(2);
  });

  it('normalizes provider failure aliases to CRITICAL', () => {
    const result = collectSettlementCrossModuleHealth((moduleName) => ({
      status: moduleName === 'sports' ? 'ERROR' : 'HEALTHY',
    }));

    expect(result.status).toBe('CRITICAL');
    expect(result.modules.sports.status).toBe('CRITICAL');
    expect(result.alerts[0]).toMatchObject({
      code: 'SPORTS_MODULE_CRITICAL',
      severity: 'CRITICAL',
    });
  });

  it('maps unrecognized module states to UNKNOWN instead of leaking arbitrary values', () => {
    const result = collectSettlementCrossModuleHealth((moduleName) => ({
      status: moduleName === 'odds' ? 'STARTING_UP' : 'HEALTHY',
    }));

    expect(result.status).toBe('UNKNOWN');
    expect(result.modules.odds.status).toBe('UNKNOWN');
  });

  it('keeps a valid checkedAt string and ignores invalid timestamps', () => {
    const result = collectSettlementCrossModuleHealth((moduleName) => ({
      status: 'HEALTHY',
      checkedAt:
        moduleName === 'sports'
          ? '2026-11-10T10:00:00.000Z'
          : 'not-a-date',
    }));

    expect(result.modules.sports.checkedAt).toBe('2026-11-10T10:00:00.000Z');
    expect(result.modules.odds.checkedAt).toBeUndefined();
  });
});

