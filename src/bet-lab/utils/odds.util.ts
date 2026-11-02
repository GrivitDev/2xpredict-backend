import { BET_LAB_CONFIG } from '../config/bet-lab.config';

/** Converts ESPN/American prices or already-decimal prices into decimal odds. */
export function toDecimalOdds(value: unknown): number | null {
  if (typeof value === 'string') {
    const trimmed = value.trim().toUpperCase();
    if (!trimmed || ['N/A', 'EVEN', 'EVS', '-'].includes(trimmed)) {
      return trimmed === 'EVEN' || trimmed === 'EVS' ? 2 : null;
    }
    const signed = trimmed.replace(/,/g, '');
    const n = Number(signed);
    if (!Number.isFinite(n)) return null;
    if (signed.startsWith('+')) return roundAndValidateAmerican(n);
    return toDecimalOdds(n);
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return roundAndValidateAmerican(value);
  if (value === 0 || value === 1) return null;

  // ESPN's integer moneyline values commonly use American format. Decimal prices
  // are normally fractional values (e.g. 1.91, 2.10) or small integers such as 2.
  if (value >= 100 || (Number.isInteger(value) && value >= 10)) {
    return roundAndValidateAmerican(value);
  }
  return validateDecimal(value);
}

function roundAndValidateAmerican(value: number): number | null {
  if (value === 0) return null;
  const decimal = value < 0 ? 1 + 100 / Math.abs(value) : 1 + value / 100;
  return validateDecimal(decimal);
}

function validateDecimal(value: number): number | null {
  if (
    !Number.isFinite(value) ||
    value < BET_LAB_CONFIG.odds.minimumDecimalOdds ||
    value > BET_LAB_CONFIG.odds.maximumDecimalOdds
  ) {
    return null;
  }
  return Number(value.toFixed(BET_LAB_CONFIG.odds.decimalPlaces));
}

export function fairDecimalOdds(probability: number): number | null {
  if (!Number.isFinite(probability) || probability <= 0 || probability > 1)
    return null;
  return validateDecimal(1 / probability);
}

export function impliedProbability(decimalOdds: number): number | null {
  if (
    !Number.isFinite(decimalOdds) ||
    decimalOdds < BET_LAB_CONFIG.odds.minimumDecimalOdds
  )
    return null;
  return 1 / decimalOdds;
}

export function normalizeProbabilities(odds: {
  home: number;
  draw: number;
  away: number;
}): { home: number; draw: number; away: number } | null {
  const home = impliedProbability(odds.home);
  const draw = impliedProbability(odds.draw);
  const away = impliedProbability(odds.away);
  if (home === null || draw === null || away === null) return null;
  const sum = home + draw + away;
  if (!Number.isFinite(sum) || sum <= 0) return null;
  return { home: home / sum, draw: draw / sum, away: away / sum };
}

export function roundDecimal(value: number, decimalPlaces = 4): number {
  const scale = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function lineNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
