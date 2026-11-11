import mongoose from 'mongoose';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error('MONGODB_URI is required. Set it to the staging or production MongoDB connection string.');
  }

  const collectionName = (process.env.MONGO_TRANSACTION_PROBE_COLLECTION ?? 'users').trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(collectionName)) {
    throw new Error('MONGO_TRANSACTION_PROBE_COLLECTION contains unsupported characters.');
  }

  const connection = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    appName: '2xPredict-transaction-preflight',
  }).asPromise();

  let session: mongoose.ClientSession | undefined;
  try {
    const db = connection.db;
    if (!db) throw new Error('MongoDB connection has no selected database.');

    const hello = await db.admin().command({ hello: 1 });
    const isReplicaSet = typeof hello.setName === 'string' && hello.setName.length > 0;
    const isSharded = hello.msg === 'isdbgrid';
    if (!isReplicaSet && !isSharded) {
      throw new Error(
        'MongoDB is not running as a replica set or sharded cluster. Multi-document transactions used by 2xPredict require a transaction-capable topology.',
      );
    }

    const exists = await db.listCollections({ name: collectionName }, { nameOnly: true }).hasNext();
    if (!exists) {
      throw new Error(
        `Probe collection "${collectionName}" does not exist. Set MONGO_TRANSACTION_PROBE_COLLECTION to an existing collection.`,
      );
    }

    session = await connection.startSession();
    await session.withTransaction(async () => {
      // Read-only transaction probe: no business documents are changed.
      await db.collection(collectionName).findOne({}, { session });
    }, {
      readConcern: { level: 'snapshot' },
      readPreference: 'primary',
      writeConcern: { w: 'majority' },
    });

    const topology = isReplicaSet ? `replica set (${hello.setName})` : 'sharded cluster';
    console.log(`PASS: MongoDB transaction support confirmed on ${topology}.`);
    console.log(`PASS: Read-only transaction probe completed against collection "${collectionName}".`);
    console.log('No business records were inserted, updated or deleted.');
  } finally {
    if (session) await session.endSession();
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
