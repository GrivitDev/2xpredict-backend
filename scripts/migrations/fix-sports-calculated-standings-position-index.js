/**
 * Repairs the obsolete unique standings-position index in the production
 * 2xPredict database.
 *
 * The active SportsCalculatedStandings schema stores one document per team
 * with a top-level `position` field and declares this compound index as
 * NON-UNIQUE. A unique position index left by an older deployment prevents
 * teams from exchanging positions during unordered bulk updates.
 *
 * This migration:
 *   1. Drops only an exact-match UNIQUE index on
 *      { competitionId: 1, seasonId: 1, position: 1 }.
 *   2. Ensures the same index exists as NON-UNIQUE.
 *
 * No standings documents are deleted or rewritten. The separate unique index
 * on { competitionId: 1, seasonId: 1, teamId: 1 } or the unique `id` index
 * is not modified.
 */

const targetDb = db.getSiblingDB('2xpredict');
const collection = targetDb.getCollection('sports_calculated_standings');
const expectedFields = ['competitionId', 'seasonId', 'position'];
const expectedKey = {
  competitionId: 1,
  seasonId: 1,
  position: 1,
};
const expectedIndexName =
  'competitionId_1_seasonId_1_position_1';

function hasExactKeyPattern(key) {
  const entries = Object.entries(key || {});
  return (
    entries.length === expectedFields.length &&
    entries.every(
      ([field, direction], index) =>
        field === expectedFields[index] && direction === 1,
    )
  );
}

const initialIndexes = collection.getIndexes();
const obsoleteUniqueIndexes = initialIndexes.filter(
  (index) => index.unique === true && hasExactKeyPattern(index.key),
);

for (const index of obsoleteUniqueIndexes) {
  print(`Dropping obsolete unique index: ${index.name}`);
  collection.dropIndex(index.name);
}

let currentIndexes = collection.getIndexes();
const nonUniquePositionIndex = currentIndexes.find(
  (index) => index.unique !== true && hasExactKeyPattern(index.key),
);

if (!nonUniquePositionIndex) {
  print('Creating the schema-aligned non-unique standings position index.');
  collection.createIndex(expectedKey, { name: expectedIndexName });
} else {
  print(`Non-unique standings position index already exists: ${nonUniquePositionIndex.name}`);
}

currentIndexes = collection.getIndexes();
const remainingUniquePositionIndexes = currentIndexes.filter(
  (index) => index.unique === true && hasExactKeyPattern(index.key),
);
const remainingNonUniquePositionIndexes = currentIndexes.filter(
  (index) => index.unique !== true && hasExactKeyPattern(index.key),
);

if (remainingUniquePositionIndexes.length > 0) {
  throw new Error(
    `Obsolete unique position index still exists: ${remainingUniquePositionIndexes
      .map((index) => index.name)
      .join(', ')}`,
  );
}

if (remainingNonUniquePositionIndexes.length === 0) {
  throw new Error(
    'The expected non-unique standings position index was not created.',
  );
}

print(
  `sports_calculated_standings index migration complete. Non-unique position index: ${remainingNonUniquePositionIndexes
    .map((index) => index.name)
    .join(', ')}. Other indexes were left unchanged.`,
);
