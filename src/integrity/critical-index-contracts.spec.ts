import { PaymentSchema } from '../payments/schemas/payment.schema';
import { PlanConfigSchema } from '../plan-config/schemas/plan-config.schema';
import { BetLabWalletSchema } from '../bet-lab/schemas/bet-lab-wallet.schema';
import { BetLabWalletLedgerSchema } from '../bet-lab/schemas/bet-lab-wallet-ledger.schema';
import { BetLabTicketSchema } from '../bet-lab/schemas/bet-lab-ticket.schema';
import { FixtureOddsSchema } from '../odds/schemas/fixture-odds.schema';
import { SettlementJobSchema } from '../settlement/schemas/settlement-job.schema';
import { PredictionQueueSchema } from '../predictions-engine/schemas/prediction-queue.schema';

const indexesOf = (schema: any) => schema.indexes() as Array<[Record<string, 1 | -1>, Record<string, any>]>;
const hasIndex = (
  schema: any,
  keys: Record<string, 1 | -1>,
  options: Record<string, unknown> = {},
) => indexesOf(schema).some(([actualKeys, actualOptions]) =>
  JSON.stringify(actualKeys) === JSON.stringify(keys) &&
  Object.entries(options).every(([key, value]) => JSON.stringify(actualOptions[key]) === JSON.stringify(value)),
);

describe('critical MongoDB index contracts', () => {
  it('protects payment references, active requests and recovery scans', () => {
    expect(hasIndex(PaymentSchema, { reference: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(PaymentSchema, { activeRequestKey: 1 }, { unique: true, sparse: true })).toBe(true);
    expect(hasIndex(PaymentSchema, { status: 1, processingLeaseExpiresAt: 1, createdAt: 1 })).toBe(true);
  });

  it('enforces one Plan Configuration singleton key', () => {
    expect(hasIndex(
      PlanConfigSchema,
      { configKey: 1 },
      {
        unique: true,
        partialFilterExpression: { configKey: { $type: 'string' } },
      },
    )).toBe(true);
  });

  it('enforces one wallet per user and idempotent wallet ledger entries', () => {
    expect(hasIndex(BetLabWalletSchema, { userId: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(
      BetLabWalletLedgerSchema,
      { userId: 1, idempotencyKey: 1 },
      { unique: true },
    )).toBe(true);
  });

  it('enforces unique ticket idempotency and unique ticket numbers', () => {
    expect(hasIndex(BetLabTicketSchema, { ticketNumber: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(BetLabTicketSchema, { userId: 1, idempotencyKey: 1 }, { unique: true })).toBe(true);
  });

  it('enforces unique canonical odds rows and TTL expiry', () => {
    expect(hasIndex(
      FixtureOddsSchema,
      { eventId: 1, marketId: 1, selectionKey: 1, line: 1 },
      { unique: true },
    )).toBe(true);
    expect(hasIndex(FixtureOddsSchema, { expiresAt: 1 }, { expireAfterSeconds: 0 })).toBe(true);
  });

  it('enforces one settlement job per event and source fingerprint', () => {
    expect(hasIndex(
      SettlementJobSchema,
      { eventId: 1, sourceFingerprint: 1 },
      { unique: true },
    )).toBe(true);
  });

  it('enforces one prediction queue row per fixture and indexes due work', () => {
    expect(hasIndex(PredictionQueueSchema, { eventId: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(PredictionQueueSchema, {
      status: 1,
      availableAt: 1,
      priority: -1,
      fixtureDate: 1,
    })).toBe(true);
  });
});
