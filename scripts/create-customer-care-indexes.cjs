/*
 * One-time index migration for the asynchronous Customer Care queue.
 * Run from the backend directory after the updated files are installed:
 *   node .\scripts\create-customer-care-indexes.cjs
 */
const path = require('node:path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const mongoose = require('mongoose');

const indexesByCollection = {
  support_conversations: [
    {
      key: { userId: 1, lastMessageAt: -1 },
      name: 'userId_1_lastMessageAt_-1',
    },
    {
      key: { retentionDeleting: 1, lastMessageAt: 1, createdAt: 1 },
      name: 'support_retention_candidate_lookup',
    },
    {
      key: { retentionDeleting: 1, retentionDeletionStartedAt: 1 },
      name: 'support_retention_stale_lock_lookup',
    },
  ],
  support_messages: [
    { key: { conversationId: 1, createdAt: 1 }, name: 'conversationId_1_createdAt_1' },
    { key: { userId: 1, createdAt: -1 }, name: 'userId_1_createdAt_-1' },
    {
      key: { userId: 1, role: 1, createdAt: -1 },
      name: 'support_user_role_message_time_lookup',
    },
    {
      key: { conversationId: 1, userId: 1, role: 1, createdAt: -1 },
      name: 'support_conversation_history_lookup',
    },
    {
      key: { conversationId: 1, role: 1, replyStatus: 1 },
      name: 'support_active_reply_retention_lookup',
    },
    {
      key: { userId: 1, idempotencyKey: 1 },
      name: 'uniq_support_user_idempotency_key',
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    },
    {
      key: { replyToMessageId: 1 },
      name: 'uniq_support_reply_per_user_message',
      unique: true,
      partialFilterExpression: { replyToMessageId: { $type: 'objectId' } },
    },
  ],
  support_rate_limits: [
    {
      key: { userId: 1 },
      name: 'uniq_support_rate_limit_user',
      unique: true,
    },
    {
      key: { expiresAt: 1 },
      name: 'ttl_support_rate_limit_expiry',
      expireAfterSeconds: 0,
    },
  ],
  customer_care_jobs: [
    { key: { jobKey: 1 }, name: 'jobKey_1', unique: true },
    { key: { status: 1, scheduledAt: 1, leaseExpiresAt: 1 }, name: 'status_1_scheduledAt_1_leaseExpiresAt_1' },
    {
      key: { status: 1, updatedAt: 1 },
      name: 'customer_care_terminal_job_retention_lookup',
    },
  ],
  customer_care_broadcasts: [
    { key: { kind: 1, dateKey: 1, sourceKey: 1 }, name: 'kind_1_dateKey_1_sourceKey_1', unique: true },
    { key: { status: 1, updatedAt: -1 }, name: 'status_1_updatedAt_-1' },
  ],
  support_incidents: [
    { key: { status: 1, severity: -1, lastSeenAt: -1 }, name: 'status_1_severity_-1_lastSeenAt_-1' },
    { key: { fingerprint: 1, status: 1, lastSeenAt: -1 }, name: 'fingerprint_1_status_1_lastSeenAt_-1' },
    {
      key: { status: 1, resolvedAt: 1 },
      name: 'support_incident_resolved_retention_lookup',
    },
  ],
  support_action_audits: [
    { key: { createdAt: -1, actionType: 1 }, name: 'createdAt_-1_actionType_1' },
    {
      key: { actionName: 1, createdAt: -1 },
      name: 'support_action_latest_by_name',
    },
  ],
  customer_care_reply_jobs: [
    { key: { jobKey: 1 }, name: 'jobKey_1', unique: true },
    { key: { userMessageId: 1 }, name: 'userMessageId_1' },
    { key: { userId: 1 }, name: 'userId_1' },
    {
      key: { status: 1, scheduledAt: 1, createdAt: 1 },
      name: 'support_reply_queue_order',
    },
    {
      key: { status: 1, leaseExpiresAt: 1 },
      name: 'support_reply_expired_lease_lookup',
    },
    {
      key: { conversationId: 1, status: 1, createdAt: 1 },
      name: 'support_reply_conversation_order',
    },
    {
      key: { status: 1, updatedAt: 1 },
      name: 'support_reply_terminal_retention_lookup',
    },
    {
      key: { completedAt: 1 },
      name: 'ttl_customer_care_reply_job_terminal_90d',
      expireAfterSeconds: 90 * 24 * 60 * 60,
    },
  ],
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI was not found. Run this script from backend with its .env file available.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error('Mongoose connected without an available database handle.');

  for (const [collectionName, indexes] of Object.entries(indexesByCollection)) {
    const created = await db.collection(collectionName).createIndexes(indexes);
    process.stdout.write(`${collectionName}: ensured ${created.length} index(es)\n`);
  }
  process.stdout.write('Customer Care queue, idempotency, retention, and rate-limit indexes are ready.\n');
}

main()
  .catch((error) => {
    process.stderr.write(`Customer Care index migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
