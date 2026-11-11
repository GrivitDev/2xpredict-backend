import mongoose from 'mongoose';
import { PaymentSchema } from '../src/payments/schemas/payment.schema';
import { PlanConfigSchema } from '../src/plan-config/schemas/plan-config.schema';
import { BetLabWalletSchema } from '../src/bet-lab/schemas/bet-lab-wallet.schema';
import { BetLabWalletLedgerSchema } from '../src/bet-lab/schemas/bet-lab-wallet-ledger.schema';
import { BetLabTicketSchema } from '../src/bet-lab/schemas/bet-lab-ticket.schema';
import { FixtureOddsSchema } from '../src/odds/schemas/fixture-odds.schema';
import { SettlementJobSchema } from '../src/settlement/schemas/settlement-job.schema';
import { PredictionQueueSchema } from '../src/predictions-engine/schemas/prediction-queue.schema';

const criticalSchemas = [
  { modelName: 'Payment', schema: PaymentSchema },
  { modelName: 'PlanConfig', schema: PlanConfigSchema },
  { modelName: 'BetLabWallet', schema: BetLabWalletSchema },
  { modelName: 'BetLabWalletLedger', schema: BetLabWalletLedgerSchema },
  { modelName: 'BetLabTicket', schema: BetLabTicketSchema },
  { modelName: 'FixtureOdds', schema: FixtureOddsSchema },
  { modelName: 'SettlementJob', schema: SettlementJobSchema },
  { modelName: 'PredictionQueue', schema: PredictionQueueSchema },
] as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return stable(left) === stable(right);
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is required.');

  const connection = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    appName: '2xPredict-index-preflight',
    autoIndex: false,
  }).asPromise();

  const missing: string[] = [];
  try {
    for (const definition of criticalSchemas) {
      const model = connection.model(definition.modelName, definition.schema as any);
      const actualIndexes = await model.collection.indexes();
      const declaredIndexes = definition.schema.indexes() as Array<[
        Record<string, 1 | -1>,
        Record<string, unknown>,
      ]>;

      for (const [keys, options] of declaredIndexes) {
        const actual = actualIndexes.find((index) => sameKeys(index.key as Record<string, unknown>, keys));
        const label = `${model.collection.name}: ${stable(keys)}`;
        if (!actual) {
          missing.push(`${label} (missing)`);
          continue;
        }
        for (const option of ['unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression'] as const) {
          if (options[option] !== undefined && stable(actual[option]) !== stable(options[option])) {
            missing.push(`${label} (option ${option} differs; expected ${stable(options[option])}, actual ${stable(actual[option])})`);
          }
        }
      }
      console.log(`Checked ${declaredIndexes.length} declared index(es): ${model.collection.name}`);
    }
  } finally {
    await connection.close();
  }

  if (missing.length) {
    console.error(`FAIL: ${missing.length} critical index mismatch(es):`);
    for (const item of missing) console.error(`- ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS: all declared critical schema indexes and required constraints exist in MongoDB.');
  console.log('This check is read-only; it does not create, rebuild or drop indexes.');
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
