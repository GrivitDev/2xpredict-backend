import { of, throwError } from 'rxjs';
import { PaystackProvider } from './paystack.provider';

const makeProvider = (http: Record<string, any>) =>
  new PaystackProvider(
    http as any,
    { getOrThrow: jest.fn().mockReturnValue('sk_test_example') } as any,
  );

describe('PaystackProvider outbound request contract', () => {
  it('sets a finite initialization timeout and normalizes a valid response', async () => {
    const http = {
      post: jest.fn().mockReturnValue(of({
        data: {
          status: true,
          data: {
            authorization_url: 'https://checkout.example.test/session',
            access_code: 'access-123',
            reference: 'ref-123',
          },
        },
      })),
    };
    const provider = makeProvider(http);
    const result = await provider.initializePayment({
      email: 'user@example.test',
      amount: 1000,
      reference: 'ref-123',
      callbackUrl: 'https://example.test/payment/callback',
    } as any);

    expect(http.post.mock.calls[0][2].timeout).toBe(15_000);
    expect(result).toEqual({
      authorizationUrl: 'https://checkout.example.test/session',
      accessCode: 'access-123',
      reference: 'ref-123',
    });
  });

  it('sets a finite verification timeout and treats transport errors as unknown', async () => {
    const http = {
      get: jest.fn().mockReturnValue(throwError(() => new Error('socket timeout'))),
    };
    const provider = makeProvider(http);
    const result = await provider.verifyPayment('ref with spaces');

    expect(http.get.mock.calls[0][0]).toContain('ref%20with%20spaces');
    expect(http.get.mock.calls[0][1].timeout).toBe(12_000);
    expect(result.success).toBe(false);
    expect(result.status).toBe('unknown');
  });

  it('keeps a successful verification distinct from a pending transaction', async () => {
    const http = {
      get: jest.fn().mockReturnValue(of({
        data: {
          status: true,
          data: {
            id: 123,
            reference: 'ref-success',
            status: 'success',
            amount: 100000,
            currency: 'NGN',
          },
        },
      })),
    };
    const provider = makeProvider(http);
    const result = await provider.verifyPayment('ref-success');
    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: 'success',
      reference: 'ref-success',
      transactionId: '123',
      amountMinor: 100000,
      currency: 'NGN',
    }));
  });
});
