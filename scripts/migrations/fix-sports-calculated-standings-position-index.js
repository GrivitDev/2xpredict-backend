// Run with mongosh against the target 2xPredict database.
// This replaces only the stale unique position index; it does not modify documents.

const collection = db.getCollection('sports_calculated_standings');
const indexName = 'competitionId_1_seasonId_1_position_1';
const expectedKey = { competitionId: 1, seasonId: 1, position: 1 };

function hasExpectedKey(index) {
  const fields = Object.keys(index.key || {});
  return (
    fields.length === 3 &&
    fields[0] === 'competitionId' &&
    fields[1] === 'seasonId' &&
    fields[2] === 'position' &&
    index.key.competitionId === 1 &&
    index.key.seasonId === 1 &&
    index.key.position === 1
  );
}

let existing = collection.getIndexes().find((index) => index.name === indexName);

if (existing && (existing.unique === true || !hasExpectedKey(existing))) {
  print(`Dropping stale index: ${indexName}`);
  collection.dropIndex(indexName);
  existing = undefined;
}

if (!existing) {
  collection.createIndex(expectedKey, { name: indexName });
  print(`Created non-unique index: ${indexName}`);
} else {
  print(`Index already has the expected non-unique definition: ${indexName}`);
}

const finalIndex = collection.getIndexes().find((index) => index.name === indexName);
if (!finalIndex || finalIndex.unique === true || !hasExpectedKey(finalIndex)) {
  throw new Error(`Index migration verification failed for ${indexName}`);
}

print('Sports calculated standings index migration completed successfully.');
