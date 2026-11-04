import { MarketFamily } from '../enums/market-family.enum';
import { MarketModel } from '../enums/market-model.enum';
import { PredictionMarket } from '../enums/prediction-market.enum';
import { MarketDefinition } from '../interfaces/market-catalog.interface';
import { FOOTBALL_MARKET_CATALOG as CANONICAL_MARKETS } from '../../odds/catalog/football-market-catalog';

function attachSelectionTemplates(
  definition: MarketDefinition,
): MarketDefinition {
  if (
    definition.selectionMode === 'STATIC' ||
    definition.selectionMode === 'EXACT_TOTAL'
  )
    return definition;

  const templateByMode: Partial<
    Record<
      MarketDefinition['selectionMode'],
      MarketDefinition['selectionTemplates']
    >
  > = {
    OVER_UNDER: [
      {
        keyPatterns: ['OVER_{LINE_SLUG}', 'UNDER_{LINE_SLUG}'],
        jsonVariablePatterns: ['over{LINE_VARIABLE}', 'under{LINE_VARIABLE}'],
        fullNamePatterns: ['Over {LINE}', 'Under {LINE}'],
        abbreviationPatterns: ['O {LINE}', 'U {LINE}'],
      },
    ],
    CORRECT_SCORE: [
      {
        keyPatterns: ['SCORE_{HOME_GOALS}_{AWAY_GOALS}'],
        jsonVariablePatterns: ['score{HOME_GOALS}{AWAY_GOALS}'],
        fullNamePatterns: ['{HOME_GOALS}-{AWAY_GOALS}'],
        abbreviationPatterns: ['{HOME_GOALS}:{AWAY_GOALS}'],
        condition:
          definition.period === 'FULL_TIME'
            ? 'Home and away goals each range from 0 through 8.'
            : 'Home and away goals each range from 0 through 5 for the first half.',
      },
    ],
    ASIAN_HANDICAP: [
      {
        keyPatterns: ['HOME_{LINE_SLUG}', 'AWAY_{LINE_SLUG}'],
        jsonVariablePatterns: [
          'homeHandicap{LINE_VARIABLE}',
          'awayHandicap{LINE_VARIABLE}',
        ],
        fullNamePatterns: [
          '{HOME_TEAM} ({SIGNED_LINE})',
          '{AWAY_TEAM} ({SIGNED_LINE})',
        ],
        abbreviationPatterns: ['1 {SIGNED_LINE}', '2 {SIGNED_LINE}'],
        condition:
          'Each selection applies the listed handicap to that selected team; quarter-lines use split-stake Asian handicap settlement profiles.',
      },
    ],
    EUROPEAN_HANDICAP: [
      {
        keyPatterns: [
          'HOME_{LINE_SLUG}',
          'DRAW_{LINE_SLUG}',
          'AWAY_{LINE_SLUG}',
        ],
        jsonVariablePatterns: [
          'home{LINE_VARIABLE}',
          'draw{LINE_VARIABLE}',
          'away{LINE_VARIABLE}',
        ],
        fullNamePatterns: [
          '{HOME_TEAM} (handicap {SIGNED_LINE})',
          'Draw (home handicap {SIGNED_LINE})',
          '{AWAY_TEAM} (home handicap {SIGNED_LINE})',
        ],
        abbreviationPatterns: ['1', 'X', '2'],
      },
    ],
    BTTS_TOTAL: [
      {
        keyPatterns: [
          'YES_OVER_{LINE_SLUG}',
          'NO_OVER_{LINE_SLUG}',
          'NO_UNDER_{LINE_SLUG}',
          'YES_UNDER_{LINE_SLUG}',
        ],
        jsonVariablePatterns: [
          'yesAndOver{LINE_VARIABLE}',
          'noAndOver{LINE_VARIABLE}',
          'noAndUnder{LINE_VARIABLE}',
          'yesAndUnder{LINE_VARIABLE}',
        ],
        fullNamePatterns: [
          'BTTS Yes & Over {LINE}',
          'BTTS No & Over {LINE}',
          'BTTS No & Under {LINE}',
          'BTTS Yes & Under {LINE}',
        ],
        abbreviationPatterns: [
          'GG + O{LINE}',
          'NG + O{LINE}',
          'NG + U{LINE}',
          'GG + U{LINE}',
        ],
        condition:
          'The Yes & Under selection is generated only for lines above 1.5 because both teams must score at least one goal.',
      },
    ],
    POSSESSION: [
      {
        keyPatterns: ['OVER_{LINE_SLUG}', 'UNDER_{LINE_SLUG}'],
        jsonVariablePatterns: ['over{LINE_VARIABLE}', 'under{LINE_VARIABLE}'],
        fullNamePatterns: [
          'Home Possession Over {LINE}%',
          'Home Possession Under {LINE}%',
        ],
        abbreviationPatterns: ['O {LINE}%', 'U {LINE}%'],
        condition:
          'The current model forecasts the home team possession percentage.',
      },
    ],
    PLAYER: [
      {
        keyPatterns: [
          'PLAYER_{ATHLETE_ID}_OVER_{LINE_SLUG}',
          'PLAYER_{ATHLETE_ID}_UNDER_{LINE_SLUG}',
          'PLAYER_{ATHLETE_ID}',
        ],
        jsonVariablePatterns: [
          'player{ATHLETE_ID}Over{LINE_VARIABLE}',
          'player{ATHLETE_ID}Under{LINE_VARIABLE}',
          'player{ATHLETE_ID}',
        ],
        fullNamePatterns: [
          '{ATHLETE_NAME} Over {LINE}',
          '{ATHLETE_NAME} Under {LINE}',
          '{ATHLETE_NAME}',
        ],
        abbreviationPatterns: [
          '{ATHLETE_SHORT_NAME} O{LINE}',
          '{ATHLETE_SHORT_NAME} U{LINE}',
          '{ATHLETE_SHORT_NAME}',
        ],
        condition:
          'Player selections are generated only for eligible athletes found in the ESPN Summary roster and carry the ESPN athlete ID.',
      },
    ],
  };

  const selectionTemplates = templateByMode[definition.selectionMode];
  return selectionTemplates
    ? { ...definition, selectionTemplates }
    : definition;
}

export const FOOTBALL_MARKET_CATALOG: readonly MarketDefinition[] =
  CANONICAL_MARKETS.map((market) =>
    attachSelectionTemplates({
      key: market.predictionMarketKey as PredictionMarket,
      jsonVariable: market.jsonVariable,
      fullName: market.fullName,
      abbreviation: market.abbreviation,
      family: market.family as MarketFamily,
      model: market.model as MarketModel,
      selectionMode: market.selectionMode,
      period: market.period,
      lines: market.lines ? [...market.lines] : undefined,
      notes: market.notes,
      selections: market.selections.map((selection) => ({
        key: selection.key,
        jsonVariable: selection.jsonVariable,
        fullName: selection.fullName,
        abbreviation: selection.abbreviation,
      })),
    }),
  );

function freezeRecursively<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeRecursively(nested);
  }
  return Object.freeze(value);
}

// The engine catalogue is a derived view. Freeze its definitions and nested
// selection templates so a consumer cannot mutate the active market set.
for (const definition of FOOTBALL_MARKET_CATALOG) {
  freezeRecursively(definition);
}
Object.freeze(FOOTBALL_MARKET_CATALOG);

function createReadonlyMap<K, V>(
  entries: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
  const source = new Map<K, V>(entries);
  const view: ReadonlyMap<K, V> = {
    get size() {
      return source.size;
    },
    get(key: K) {
      return source.get(key);
    },
    has(key: K) {
      return source.has(key);
    },
    entries() {
      return source.entries();
    },
    keys() {
      return source.keys();
    },
    values() {
      return source.values();
    },
    forEach(callback, thisArg) {
      source.forEach((value, key) => {
        callback.call(thisArg, value, key, view);
      });
    },
    [Symbol.iterator](): MapIterator<[K, V]> {
      return source[Symbol.iterator]();
    },
  };
  return Object.freeze(view);
}

export const MARKET_DEFINITION_BY_KEY: ReadonlyMap<
  PredictionMarket,
  MarketDefinition
> = createReadonlyMap(
  FOOTBALL_MARKET_CATALOG.map(
    (definition) => [definition.key, definition] as const,
  ),
);

export function getMarketDefinition(key: string): MarketDefinition | undefined {
  return MARKET_DEFINITION_BY_KEY.get(key as PredictionMarket);
}
