export type ScoreMatrix = number[][];

export class PredictionMathUtil {
  static clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  static normalize(values: number[]): number[] {
    const safe = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
    const total = safe.reduce((sum, v) => sum + v, 0);
    if (total <= 0) return safe.map(() => 0);
    return safe.map((v) => v / total);
  }

  static poissonPmf(lambda: number, k: number): number {
    if (k < 0 || !Number.isInteger(k)) return 0;
    const boundedLambda = this.clamp(lambda, 0.0001, 12);
    if (k === 0) return Math.exp(-boundedLambda);
    let result = Math.exp(-boundedLambda);
    for (let i = 1; i <= k; i += 1) result *= boundedLambda / i;
    return result;
  }

  static poissonDistribution(lambda: number, max: number): number[] {
    const result = Array.from({ length: max + 1 }, (_, k) =>
      this.poissonPmf(lambda, k),
    );
    const sum = result.reduce((total, probability) => total + probability, 0);
    return sum > 0 ? result.map((probability) => probability / sum) : result;
  }

  static scoreMatrix(
    homeLambda: number,
    awayLambda: number,
    maxGoals = 8,
  ): ScoreMatrix {
    const home = this.poissonDistribution(homeLambda, maxGoals);
    const away = this.poissonDistribution(awayLambda, maxGoals);
    const matrix: ScoreMatrix = home.map((homeProbability) =>
      away.map((awayProbability) => homeProbability * awayProbability),
    );
    const total = matrix.flat().reduce((sum, value) => sum + value, 0);
    if (total > 0) {
      for (let h = 0; h < matrix.length; h += 1) {
        for (let a = 0; a < matrix[h].length; a += 1) matrix[h][a] /= total;
      }
    }
    return matrix;
  }

  static matrixProbability(
    matrix: ScoreMatrix,
    predicate: (home: number, away: number) => boolean,
  ): number {
    let total = 0;
    for (let home = 0; home < matrix.length; home += 1) {
      for (let away = 0; away < matrix[home].length; away += 1) {
        if (predicate(home, away)) total += matrix[home][away];
      }
    }
    return this.clamp(total, 0, 1);
  }

  static resultProbabilities(matrix: ScoreMatrix): {
    home: number;
    draw: number;
    away: number;
  } {
    return {
      home: this.matrixProbability(matrix, (h, a) => h > a),
      draw: this.matrixProbability(matrix, (h, a) => h === a),
      away: this.matrixProbability(matrix, (h, a) => h < a),
    };
  }

  static normalizeResultMatrix(
    matrix: ScoreMatrix,
    target: { home: number; draw: number; away: number },
  ): ScoreMatrix {
    const current = this.resultProbabilities(matrix);
    const output = matrix.map((row) => [...row]);
    const targets = { home: target.home, draw: target.draw, away: target.away };
    for (let h = 0; h < output.length; h += 1) {
      for (let a = 0; a < output[h].length; a += 1) {
        const key = h > a ? 'home' : h === a ? 'draw' : 'away';
        const originalBucket = current[key];
        output[h][a] =
          originalBucket > 0
            ? (output[h][a] * targets[key]) / originalBucket
            : 0;
      }
    }
    const sum = output
      .flat()
      .reduce((total, probability) => total + probability, 0);
    return sum > 0 ? output.map((row) => row.map((p) => p / sum)) : matrix;
  }

  static normalizeThreeWay(input: {
    home: number;
    draw: number;
    away: number;
  }): { home: number; draw: number; away: number } {
    const values = this.normalize([input.home, input.draw, input.away]);
    return { home: values[0] ?? 0, draw: values[1] ?? 0, away: values[2] ?? 0 };
  }

  static decimalFairOdds(probability: number): number | null {
    if (!Number.isFinite(probability) || probability <= 0 || probability > 1)
      return null;
    return Number((1 / probability).toFixed(3));
  }

  /**
   * Expected net return per unit stake. Most markets have binary settlement and
   * use p * odds - 1. Asian handicaps can push or half-settle; their probability
   * is conditional on decisive settlement, so the return is scaled by the
   * effective decisive stake mass to avoid overstating value.
   */
  static expectedValue(
    probability: number,
    decimalOdds: number,
    settlementProfile?: {
      fullWin?: number;
      halfWin?: number;
      push?: number;
      halfLoss?: number;
      fullLoss?: number;
    } | null,
  ): number | null {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1
      || !Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;

    const profile = settlementProfile;
    if (!profile) return Number((probability * decimalOdds - 1).toFixed(6));
    const fullWin = this.clamp(Number(profile.fullWin ?? 0), 0, 1);
    const halfWin = this.clamp(Number(profile.halfWin ?? 0), 0, 1);
    const halfLoss = this.clamp(Number(profile.halfLoss ?? 0), 0, 1);
    const fullLoss = this.clamp(Number(profile.fullLoss ?? 0), 0, 1);
    const effectiveWin = fullWin + halfWin * 0.5;
    const effectiveLoss = fullLoss + halfLoss * 0.5;
    const decisiveMass = effectiveWin + effectiveLoss;
    if (decisiveMass <= 0 || !Number.isFinite(decisiveMass)) {
      return Number((probability * decimalOdds - 1).toFixed(6));
    }
    return Number(((probability * decimalOdds - 1) * Math.min(1, decisiveMass)).toFixed(6));
  }

  static probabilityFromAmericanOdds(odds: number): number | null {
    if (!Number.isFinite(odds) || odds === 0) return null;
    if (odds > 0) return 100 / (odds + 100);
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }

  static americanToDecimalOdds(odds: number): number | null {
    if (!Number.isFinite(odds) || odds === 0) return null;
    if (odds > 0) return Number((1 + odds / 100).toFixed(4));
    return Number((1 + 100 / Math.abs(odds)).toFixed(4));
  }

  static decimalFromProviderValue(
    value: unknown,
    americanPreferred = false,
  ): number | null {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return null;
    if (americanPreferred && Math.abs(num) >= 100)
      return this.americanToDecimalOdds(num);
    if (!americanPreferred && Number.isInteger(num) && Math.abs(num) >= 100)
      return this.americanToDecimalOdds(num);
    if (num > 1 && num <= 1000) return num;
    return null;
  }

  static normalCdf(z: number): number {
    // Abramowitz–Stegun erf approximation; adequate for market-line estimates.
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * x);
    const erf =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
        t +
        0.254829592) *
        t *
        Math.exp(-x * x);
    return this.clamp(0.5 * (1 + sign * erf), 0, 1);
  }

  static average(values: number[]): number | null {
    const valid = values.filter(
      (value) => Number.isFinite(value) && value >= 0,
    );
    return valid.length
      ? valid.reduce((sum, value) => sum + value, 0) / valid.length
      : null;
  }

  static roundProbability(value: number): number {
    // Significant-digit rounding preserves very small but non-zero markets such
    // as exact 8-8 scores. Fixed decimal places incorrectly rounded them to 0,
    // which then made fair decimal odds undefined.
    const bounded = this.clamp(value, 0, 1);
    if (bounded === 0 || bounded === 1) return bounded;
    return Number(bounded.toPrecision(12));
  }

  static safeLogit(probability: number): number {
    const p = this.clamp(probability, 0.000001, 0.999999);
    return Math.log(p / (1 - p));
  }

  static sigmoid(value: number): number {
    return 1 / (1 + Math.exp(-value));
  }
}

