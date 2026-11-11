import { PredictionModelInput } from '../../interfaces/prediction-match-context.interface';
import { ExpandedMarketSelection } from '../../interfaces/market-catalog.interface';
import { SelectionModelOutput } from '../../interfaces/market-engine-output.interface';
import { PredictionSource } from '../../enums/prediction-source.enum';
import { PredictionMathUtil } from '../../utils/prediction-math.util';

export function matrixProbability(
  matrix: number[][],
  predicate: (home: number, away: number) => boolean,
): number {
  let probability = 0;
  for (let home = 0; home < matrix.length; home += 1) {
    for (let away = 0; away < matrix[home].length; away += 1) {
      if (predicate(home, away)) probability += matrix[home][away];
    }
  }
  return probability;
}

export function resultProbability(matrix: number[][], key: string): number {
  return matrixProbability(matrix, (home, away) => {
    if (key === 'HOME_WIN') return home > away;
    if (key === 'DRAW') return home === away;
    return home < away;
  });
}

export function totalGoalsProbability(
  matrix: number[][],
  predicate: (total: number) => boolean,
): number {
  return matrixProbability(matrix, (home, away) => predicate(home + away));
}

export function countOverProbability(lambda: number, line: number): number {
  let under = 0;
  for (let count = 0; count <= Math.floor(line); count += 1) {
    under += PredictionMathUtil.poissonPmf(lambda, count);
  }
  // Remaining mass above the truncated tail is conservatively assigned to Over.
  return PredictionMathUtil.clamp(1 - under, 0, 1);
}

export function countExactProbability(lambda: number, exact: number): number {
  if (exact >= 6) {
    let below = 0;
    for (let count = 0; count <= 5; count += 1)
      below += PredictionMathUtil.poissonPmf(lambda, count);
    return PredictionMathUtil.clamp(1 - below, 0, 1);
  }
  return PredictionMathUtil.poissonPmf(lambda, exact);
}

export function selectionOutput(
  selection: ExpandedMarketSelection,
  probability: number | null,
  method: string,
  source: PredictionSource[],
  dataQuality: number,
  diagnostics: string[] = [],
  settlementProfile?: SelectionModelOutput['settlementProfile'],
): SelectionModelOutput {
  const valid =
    probability !== null &&
    Number.isFinite(probability) &&
    probability >= 0 &&
    probability <= 1;
  return {
    selection,
    probability: valid
      ? PredictionMathUtil.roundProbability(probability)
      : null,
    status: valid ? 'CALCULATED' : 'UNAVAILABLE',
    source,
    method,
    diagnostics,
    dataQuality: Math.max(0, Math.min(1, dataQuality)),
    ...(settlementProfile ? { settlementProfile } : {}),
  };
}

export function resultKeyForScore(
  home: number,
  away: number,
): 'HOME_WIN' | 'DRAW' | 'AWAY_WIN' {
  return home > away ? 'HOME_WIN' : home === away ? 'DRAW' : 'AWAY_WIN';
}

export function asianHandicapOutput(
  matrix: number[][],
  selection: ExpandedMarketSelection,
  modelInput: PredictionModelInput,
  method: string,
): SelectionModelOutput {
  const side = selection.side ?? 'HOME';
  const handicap = selection.handicap ?? 0;
  const componentLines = asianComponents(handicap);
  let fullWin = 0;
  let halfWin = 0;
  let push = 0;
  let halfLoss = 0;
  let fullLoss = 0;

  for (let home = 0; home < matrix.length; home += 1) {
    for (let away = 0; away < matrix[home].length; away += 1) {
      const scoreProbability = matrix[home][away];
      if (scoreProbability <= 0) continue;
      const goalMargin = side === 'HOME' ? home - away : away - home;
      const componentResults = componentLines.map((component) => {
        const adjusted = goalMargin + component;
        return adjusted > 0 ? 'WIN' : adjusted === 0 ? 'PUSH' : 'LOSS';
      });
      const componentWeight = 1 / componentResults.length;
      const wins = componentResults.filter(
        (outcome) => outcome === 'WIN',
      ).length;
      const pushes = componentResults.filter(
        (outcome) => outcome === 'PUSH',
      ).length;
      const losses = componentResults.filter(
        (outcome) => outcome === 'LOSS',
      ).length;

      if (wins === componentResults.length) fullWin += scoreProbability;
      else if (losses === componentResults.length) fullLoss += scoreProbability;
      else if (pushes === componentResults.length) push += scoreProbability;
      else if (wins > 0 && pushes > 0) halfWin += scoreProbability;
      else if (losses > 0 && pushes > 0) halfLoss += scoreProbability;
      else if (wins > 0 && losses > 0) {
        // Quarter lines split equally over adjacent lines; one win plus one loss is net push.
        push += scoreProbability;
      } else {
        // Numerically safe fallback for a mixed result profile.
        for (const result of componentResults) {
          if (result === 'WIN') halfWin += scoreProbability * componentWeight;
          else if (result === 'PUSH')
            push += scoreProbability * componentWeight;
          else halfLoss += scoreProbability * componentWeight;
        }
      }
    }
  }

  const effectiveWin = fullWin + halfWin * 0.5;
  const effectiveLoss = fullLoss + halfLoss * 0.5;
  const decisive = effectiveWin + effectiveLoss;
  const conditionalProbability = decisive > 0 ? effectiveWin / decisive : null;
  return selectionOutput(
    selection,
    conditionalProbability,
    method,
    [PredictionSource.POISSON_SCORE_MODEL],
    0.75,
    [
      'Probability is conditional on a non-push settlement; expected settlement outcomes are separately recorded.',
    ],
    {
      fullWin: clampProfile(fullWin),
      halfWin: clampProfile(halfWin),
      push: clampProfile(push),
      halfLoss: clampProfile(halfLoss),
      fullLoss: clampProfile(fullLoss),
    },
  );
}

function asianComponents(line: number): number[] {
  const quarters = line * 4;
  if (Math.abs(quarters - Math.round(quarters)) > 0.000001) {
    return [line];
  }
  const quarterRemainder = Math.abs(Math.round(quarters)) % 2;
  // Quarter-step AH lines (e.g. -0.25, +0.75) split stakes across adjacent half-lines.
  if (quarterRemainder === 1) {
    const lower = Math.floor(line * 2) / 2;
    const upper = Math.ceil(line * 2) / 2;
    return lower === upper ? [line] : [lower, upper];
  }
  return [line];
}

function clampProfile(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
}


