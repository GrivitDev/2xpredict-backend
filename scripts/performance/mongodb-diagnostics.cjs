#!/usr/bin/env node
'use strict';

/**
 * 2xPredict Stage 7: read-only MongoDB query-plan and index diagnostics.
 *
 * This script does not insert, update, delete, create indexes, drop indexes,
 * run collection-wide counts, or change MongoDB configuration.
 */

const fs = require('node:fs');
const path = require('node:path');

function loadSimpleEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}

function parseIntegerArg(name, fallback, minimum, maximum) {
  const prefix = `--${name}=`;
  const supplied = process.argv.find((value) => value.startsWith(prefix));
  if (!supplied) return fallback;
  const parsed = Number(supplied.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseDateEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${name} must be a valid date/time value.`);
  }
  return parsed;
}

function collectPlanStages(root) {
  const stages = new Set();
  const indexNames = new Set();
  const visited = new Set();
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);

    if (typeof current.stage === 'string') stages.add(current.stage);
    if (typeof current.indexName === 'string') indexNames.add(current.indexName);

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) stack.push(...value);
        else stack.push(value);
      }
    }
  }

  return {
    stages: [...stages].sort(),
    indexNames: [...indexNames].sort(),
  };
}

function summarizeExplain(label, collectionName, explain) {
  const execution = explain.executionStats ?? {};
  const winningPlan = explain.queryPlanner?.winningPlan ?? {};
  const planSummary = collectPlanStages({ winningPlan, executionStages: execution.executionStages });
  const returned = Number(execution.nReturned ?? 0);
  const examined = Number(execution.totalDocsExamined ?? 0);
  const keysExamined = Number(execution.totalKeysExamined ?? 0);

  return {
    label,
    collection: collectionName,
    nReturned: returned,
    totalDocsExamined: examined,
    totalKeysExamined: keysExamined,
    executionTimeMillis: Number(execution.executionTimeMillis ?? 0),
    docsExaminedPerReturned: returned > 0 ? Number((examined / returned).toFixed(2)) : null,
    keysExaminedPerReturned: returned > 0 ? Number((keysExamined / returned).toFixed(2)) : null,
    stages: planSummary.stages,
    indexNames: planSummary.indexNames,
    hasCollectionScan: planSummary.stages.includes('COLLSCAN'),
    hasBlockingSort: planSummary.stages.includes('SORT'),
  };
}

async function main() {
  const backendRoot = path.resolve(__dirname, '../..');
  loadSimpleEnv(path.join(backendRoot, '.env'));

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI was not found. Set it in the backend .env file or the process environment. The URI is never printed.',
    );
  }

  const daysPast = parseIntegerArg('days-past', 7, 0, 90);
  const daysForward = parseIntegerArg('days-forward', 7, 1, 90);
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - daysPast * 86_400_000);
  const defaultTo = new Date(now.getTime() + daysForward * 86_400_000);
  const from = parseDateEnv('PERF_FROM', defaultFrom);
  const to = parseDateEnv('PERF_TO', defaultTo);
  if (to <= from) throw new Error('PERF_TO must be later than PERF_FROM.');

  // Mongoose is already a backend dependency. monitorCommands stays disabled:
  // this script only asks MongoDB for read-only plans and metadata.
  const mongoose = require('mongoose');
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 12_000,
    connectTimeoutMS: 12_000,
    monitorCommands: false,
  });

  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connected without an active database handle.');

  const report = {
    generatedAt: new Date().toISOString(),
    database: db.databaseName,
    dateWindow: { from: from.toISOString(), to: to.toISOString() },
    daysPast,
    daysForward,
    readOnly: true,
    collections: [],
    queryPlans: [],
    notes: [
      'No documents or indexes were modified.',
      'Index access counters are cumulative only since the relevant mongod process/index statistics reset; interpret them with server uptime.',
      'Explain timings are diagnostic samples, not production endpoint latency percentiles.',
      'A plan should not be changed based on COLLSCAN alone; review returned rows, examined rows, sort stages, indexes and the actual application filter together.',
    ],
  };

  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name),
  );

  const targetCollections = [
    'sports_fixtures',
    'sports_competitions',
    'sports_teams',
    'sports_match_facts',
    'sports_match_summaries',
    'sports_fixture_odds',
    'predictions_engine_pick_center',
    'predictions_engine_markets',
  ];

  async function inspectCollection(name) {
    if (!existing.has(name)) {
      report.collections.push({ collection: name, exists: false });
      return;
    }

    const collection = db.collection(name);
    const summary = { collection: name, exists: true };

    try {
      const stats = await db.command({ collStats: name, scale: 1 });
      summary.stats = {
        count: stats.count ?? null,
        sizeBytes: stats.size ?? null,
        storageSizeBytes: stats.storageSize ?? null,
        averageObjectSizeBytes: stats.avgObjSize ?? null,
        totalIndexSizeBytes: stats.totalIndexSize ?? null,
        indexCount: stats.nindexes ?? null,
      };
    } catch (error) {
      summary.statsUnavailable = String(error.message ?? error).slice(0, 240);
    }

    try {
      const indexes = await collection.listIndexes().toArray();
      summary.indexes = indexes.map((index) => ({
        name: index.name,
        key: index.key,
        unique: index.unique === true,
        sparse: index.sparse === true,
        expireAfterSeconds: index.expireAfterSeconds ?? null,
        partialFilterExpression: index.partialFilterExpression ?? null,
      }));
    } catch (error) {
      summary.indexesUnavailable = String(error.message ?? error).slice(0, 240);
    }

    try {
      const usage = await collection.aggregate([{ $indexStats: {} }], { maxTimeMS: 10_000 }).toArray();
      summary.indexUsage = usage.map((item) => ({
        name: item.name,
        operations: item.accesses?.ops ?? null,
        since: item.accesses?.since ?? null,
      }));
    } catch (error) {
      summary.indexUsageUnavailable = String(error.message ?? error).slice(0, 240);
    }

    report.collections.push(summary);
  }

  for (const name of targetCollections) await inspectCollection(name);

  async function explainFind(name, label, filter, sort, limit, projection) {
    if (!existing.has(name)) {
      report.queryPlans.push({ label, collection: name, skipped: 'Collection does not exist.' });
      return;
    }
    try {
      let cursor = db.collection(name).find(filter, projection ? { projection } : {});
      if (sort && Object.keys(sort).length) cursor = cursor.sort(sort);
      cursor = cursor.limit(limit).maxTimeMS(15_000);
      const explain = await cursor.explain('executionStats');
      report.queryPlans.push(summarizeExplain(label, name, explain));
    } catch (error) {
      report.queryPlans.push({
        label,
        collection: name,
        error: String(error.message ?? error).slice(0, 400),
      });
    }
  }

  const selectedPickFilter = {
    status: 'SELECTED',
    fixtureDate: { $gte: from, $lte: to },
  };
  const pickSample = existing.has('predictions_engine_pick_center')
    ? await db.collection('predictions_engine_pick_center')
        .find(selectedPickFilter, { projection: { _id: 0, eventId: 1, leagueId: 1, fixtureDate: 1 } })
        .sort({ fixtureDate: 1 })
        .limit(1)
        .next()
    : null;

  const fixtureSample = existing.has('sports_fixtures')
    ? await db.collection('sports_fixtures')
        .find({ kickoffAt: { $gte: from, $lte: to } }, {
          projection: {
            _id: 0,
            id: 1,
            espnEventId: 1,
            competitionId: 1,
            competitors: 1,
            kickoffAt: 1,
            'status.state': 1,
          },
        })
        .sort({ kickoffAt: 1, id: 1 })
        .limit(50)
        .toArray()
    : [];

  const eventIds = [...new Set([
    ...fixtureSample.map((item) => String(item.id ?? '')).filter(Boolean),
    ...(pickSample?.eventId ? [String(pickSample.eventId)] : []),
  ])].slice(0, 50);
  const competitionIds = [...new Set(fixtureSample.map((item) => String(item.competitionId ?? '')).filter(Boolean))].slice(0, 50);
  const teamIds = [...new Set(
    fixtureSample.flatMap((fixture) => Array.isArray(fixture.competitors)
      ? fixture.competitors.map((competitor) => String(competitor?.teamId ?? '')).filter(Boolean)
      : []),
  )].slice(0, 100);

  // The filters below mirror the corresponding normalized read-service filters.
  await explainFind(
    'sports_fixtures',
    'sports.fixtures.date-window-keyset-first-page',
    { kickoffAt: { $gte: from, $lte: to } },
    { kickoffAt: 1, id: 1 },
    101,
    { _id: 0, id: 1, kickoffAt: 1, competitionId: 1 },
  );

  const nowForRetention = new Date();
  await explainFind(
    'sports_fixtures',
    'sports.fixtures.upcoming-retained-queue-window',
    {
      kickoffAt: { $gte: nowForRetention, $lte: to > nowForRetention ? to : new Date(nowForRetention.getTime() + 7 * 86_400_000) },
      $and: [{
        $or: [
          { retentionExpiresAt: { $gt: nowForRetention } },
          { retentionExpiresAt: { $exists: false } },
          { retentionExpiresAt: null },
        ],
      }],
    },
    { kickoffAt: 1, id: 1 },
    101,
    { _id: 0, id: 1, kickoffAt: 1, retentionExpiresAt: 1 },
  );

  await explainFind(
    'predictions_engine_pick_center',
    'pick-center.selected.date-window',
    selectedPickFilter,
    { fixtureDate: 1 },
    1000,
    { _id: 0, eventId: 1, leagueId: 1, fixtureDate: 1 },
  );

  if (pickSample?.leagueId) {
    await explainFind(
      'predictions_engine_pick_center',
      'pick-center.selected.league-and-date-window',
      { ...selectedPickFilter, leagueId: String(pickSample.leagueId) },
      { fixtureDate: 1 },
      1000,
      { _id: 0, eventId: 1, leagueId: 1, fixtureDate: 1 },
    );
  }

  if (eventIds.length) {
    await explainFind(
      'predictions_engine_markets',
      'prediction-markets.fixture-event-id',
      { eventId: eventIds[0] },
      { fixtureDate: 1 },
      100,
      { _id: 1, eventId: 1, fixtureDate: 1, marketKey: 1, status: 1 },
    );
    await explainFind(
      'sports_fixture_odds',
      'odds.fixture-prices.event-id-batch',
      { eventId: { $in: eventIds.slice(0, 20) } },
      {},
      500,
      { _id: 0, eventId: 1, marketId: 1, selectionKey: 1, decimalOdds: 1 },
    );
  }

  if (competitionIds.length) {
    await explainFind(
      'sports_competitions',
      'sports.competitions.batch-identifiers',
      { $or: [ { id: { $in: competitionIds } }, { slug: { $in: competitionIds } } ] },
      {},
      100,
      { _id: 0, id: 1, slug: 1 },
    );
  }

  if (teamIds.length) {
    await explainFind(
      'sports_teams',
      'sports.teams.batch-identifiers',
      { $or: [ { id: { $in: teamIds } }, { espnId: { $in: teamIds } } ] },
      {},
      200,
      { _id: 0, id: 1, espnId: 1 },
    );
  }

  await mongoose.disconnect();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Stage 7 MongoDB diagnostics failed: ${message}\n`);
  try {
    const mongoose = require('mongoose');
    await mongoose.disconnect();
  } catch {
    // No connection was established; nothing to close.
  }
  process.exitCode = 1;
});
