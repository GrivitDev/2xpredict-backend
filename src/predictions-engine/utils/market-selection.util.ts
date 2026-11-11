import {
  ExpandedMarketSelection,
  MarketDefinition,
  MarketSelectionDefinition,
} from '../interfaces/market-catalog.interface';
import { PredictionMatchContext } from '../interfaces/prediction-match-context.interface';

function lineSlug(line: number): string {
  return String(line).replace('-', 'MINUS_').replace('.', '_');
}
function lineVariable(line: number): string {
  return String(line).replace('-', 'Minus').replace('.', '');
}
function baseSelection(
  key: string,
  jsonVariable: string,
  fullName: string,
  abbreviation: string,
): MarketSelectionDefinition {
  return { key, jsonVariable, fullName, abbreviation };
}

export function expandMarketSelections(
  definition: MarketDefinition,
  context: PredictionMatchContext,
): ExpandedMarketSelection[] {
  if (definition.selectionMode === 'OVER_UNDER') {
    // The Odds module is the authority for which exact line is available.
    // Never discard a priced line because it exceeds a legacy catalog ceiling.
    const supportedLines = (definition.lines ?? []).filter(Number.isFinite);
    return supportedLines.flatMap((line) => [
      {
        ...baseSelection(
          `OVER_${lineSlug(line)}`,
          `over${lineVariable(line)}`,
          `Over ${line}`,
          `O ${line}`,
        ),
        line,
      },
      {
        ...baseSelection(
          `UNDER_${lineSlug(line)}`,
          `under${lineVariable(line)}`,
          `Under ${line}`,
          `U ${line}`,
        ),
        line,
      },
    ]);
  }

  if (definition.selectionMode === 'EXACT_TOTAL') {
    return definition.selections.map((selection) => ({ ...selection }));
  }

  if (definition.selectionMode === 'CORRECT_SCORE') {
    const maximum = definition.period === 'FULL_TIME' ? 8 : 5;
    const selections: ExpandedMarketSelection[] = [];
    for (let homeGoals = 0; homeGoals <= maximum; homeGoals += 1) {
      for (let awayGoals = 0; awayGoals <= maximum; awayGoals += 1) {
        selections.push({
          ...baseSelection(
            `SCORE_${homeGoals}_${awayGoals}`,
            `score${homeGoals}${awayGoals}`,
            `${homeGoals}-${awayGoals}`,
            `${homeGoals}:${awayGoals}`,
          ),
          homeGoals,
          awayGoals,
        });
      }
    }
    return selections;
  }

  if (definition.selectionMode === 'ASIAN_HANDICAP') {
    return (definition.lines ?? []).flatMap((handicap) => [
      {
        ...baseSelection(
          `HOME_${lineSlug(handicap)}`,
          `homeHandicap${lineVariable(handicap)}`,
          `${context.homeTeam.name} (${handicap > 0 ? '+' : ''}${handicap})`,
          `1 ${handicap > 0 ? '+' : ''}${handicap}`,
        ),
        side: 'HOME' as const,
        handicap,
        line: handicap,
      },
      {
        ...baseSelection(
          `AWAY_${lineSlug(handicap)}`,
          `awayHandicap${lineVariable(handicap)}`,
          `${context.awayTeam.name} (${handicap > 0 ? '+' : ''}${handicap})`,
          `2 ${handicap > 0 ? '+' : ''}${handicap}`,
        ),
        side: 'AWAY' as const,
        handicap,
        line: handicap,
      },
    ]);
  }

  if (definition.selectionMode === 'EUROPEAN_HANDICAP') {
    return (definition.lines ?? []).flatMap((handicap) => [
      {
        ...baseSelection(
          `HOME_${lineSlug(handicap)}`,
          `home${lineVariable(handicap)}`,
          `${context.homeTeam.name} (handicap ${handicap > 0 ? '+' : ''}${handicap})`,
          '1',
        ),
        side: 'HOME' as const,
        handicap,
        line: handicap,
      },
      {
        ...baseSelection(
          `DRAW_${lineSlug(handicap)}`,
          `draw${lineVariable(handicap)}`,
          `Draw (home handicap ${handicap > 0 ? '+' : ''}${handicap})`,
          'X',
        ),
        handicap,
        line: handicap,
      },
      {
        ...baseSelection(
          `AWAY_${lineSlug(handicap)}`,
          `away${lineVariable(handicap)}`,
          `${context.awayTeam.name} (home handicap ${handicap > 0 ? '+' : ''}${handicap})`,
          '2',
        ),
        side: 'AWAY' as const,
        handicap,
        line: handicap,
      },
    ]);
  }

  if (definition.selectionMode === 'BTTS_TOTAL') {
    return (definition.lines ?? []).flatMap((line) => {
      const selections: ExpandedMarketSelection[] = [
        {
          ...baseSelection(
            `YES_OVER_${lineSlug(line)}`,
            `yesAndOver${lineVariable(line)}`,
            `BTTS Yes & Over ${line}`,
            `GG + O${line}`,
          ),
          line,
        },
        {
          ...baseSelection(
            `NO_OVER_${lineSlug(line)}`,
            `noAndOver${lineVariable(line)}`,
            `BTTS No & Over ${line}`,
            `NG + O${line}`,
          ),
          line,
        },
        {
          ...baseSelection(
            `NO_UNDER_${lineSlug(line)}`,
            `noAndUnder${lineVariable(line)}`,
            `BTTS No & Under ${line}`,
            `NG + U${line}`,
          ),
          line,
        },
      ];
      // Both teams need to score at least one goal, so BTTS Yes and Under 1.5
      // cannot occur together and should not be generated as a market selection.
      if (line > 1.5) {
        selections.push({
          ...baseSelection(
            `YES_UNDER_${lineSlug(line)}`,
            `yesAndUnder${lineVariable(line)}`,
            `BTTS Yes & Under ${line}`,
            `GG + U${line}`,
          ),
          line,
        });
      }
      return selections;
    });
  }

  if (definition.selectionMode === 'POSSESSION') {
    return (definition.lines ?? []).flatMap((line) => [
      {
        ...baseSelection(
          `OVER_${lineSlug(line)}`,
          `over${lineVariable(line)}`,
          `Home Possession Over ${line}%`,
          `O ${line}%`,
        ),
        line,
      },
      {
        ...baseSelection(
          `UNDER_${lineSlug(line)}`,
          `under${lineVariable(line)}`,
          `Home Possession Under ${line}%`,
          `U ${line}%`,
        ),
        line,
      },
    ]);
  }

  if (definition.selectionMode === 'PLAYER') {
    // Canonical player markets remain disabled until Sports exposes validated
    // per-appearance athlete history. A roster alone is not probability evidence.
    return [];
  }

  return definition.selections.map((selection) => ({ ...selection }));
}




