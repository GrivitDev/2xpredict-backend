const configuredBaseUrl = process.env.E2E_BASE_URL?.trim().replace(/\/+$/, '');
const enabled = Boolean(configuredBaseUrl);
const runOrSkip = enabled ? it : it.skip;

describe('2xPredict staging HTTP smoke checks', () => {
  runOrSkip('serves the public plan configuration', async () => {
    const response = await fetch(`${configuredBaseUrl}/plan-config`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({
      regularPrice: expect.any(Number),
      vipPrice: expect.any(Number),
      premiumPrice: expect.any(Number),
      subscriptionDurationDays: 30,
    }));
  });

  runOrSkip('protects the administrative system-monitor endpoint', async () => {
    const response = await fetch(`${configuredBaseUrl}/admin/system-monitor`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect([401, 403]).toContain(response.status);
  });

  if (!enabled) {
    // Skipped intentionally on unit-test/CI runs. Set E2E_BASE_URL to a staging
    // backend origin (including any configured API prefix) to execute these tests.
    console.info('Set E2E_BASE_URL to run the staging HTTP smoke checks.');
  }
});
