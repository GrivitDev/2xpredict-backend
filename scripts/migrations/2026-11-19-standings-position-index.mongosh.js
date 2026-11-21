// Run with mongosh against the 2xPredict database before deploying Stage 1A.
// This index used to be unique, which can cause E11000 conflicts when team
// positions change during a standings refresh. The unique `id` index remains
// the per-team uniqueness guarantee.
const collection = db.getCollection('sports_calculated_standings');
const expectedKeys = ['competitionId', 'seasonId', 'position'];

const sameKeys = (index) => {
  const keys = Object.keys(index.key ?? {});
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => index.key[key] === 1);
};

const oldUniqueIndex = collection.getIndexes().find(
  (index) => index.unique === true && sameKeys(index),
);
if (oldUniqueIndex) {
  print(`Dropping unique standings rank index: ${oldUniqueIndex.name}`);
  collection.dropIndex(oldUniqueIndex.name);
}

const replacementIndex = collection.getIndexes().find(
  (index) => index.unique !== true && sameKeys(index),
);
if (!replacementIndex) {
  collection.createIndex(
    { competitionId: 1, seasonId: 1, position: 1 },
    { name: 'competitionId_1_seasonId_1_position_1' },
  );
  print('Created non-unique standings rank index.');
} else {
  print(`Non-unique standings rank index already exists: ${replacementIndex.name}`);
}
