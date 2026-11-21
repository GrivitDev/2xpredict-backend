import { CuratedPredictionService } from './curated-prediction.service';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';

type MockQuery<T> = {
  select: jest.Mock;
  sort: jest.Mock;
  lean: jest.Mock;
  exec: jest.Mock<Promise<T>, []>;
};

function query<T>(value: T): MockQuery<T> {
  const result: Partial<MockQuery<T>> = {};
  result.select = jest.fn().mockReturnValue(result);
  result.sort = jest.fn().mockReturnValue(result);
  result.lean = jest.fn().mockReturnValue(result);
  result.exec = jest.fn().mockResolvedValue(value);
  return result as MockQuery<T>;
}

describe('CuratedPredictionService read efficiency', () => {
  it('loads existing curated records in one eventId batch and narrows Pick Center reads', async () => {
    const kickoff = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const oddsUpdatedAt = new Date();
    const pick = {
      eventId: 'fixture-1',
      leagueId: 'test-league',
      leagueName: 'Test League',
      fixtureDate: kickoff,
      homeTeamName: 'Home FC',
      awayTeamName: 'Away FC',
      modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
      live: false,
      completed: false,
      status: 'SELECTED',
      selectedMarkets: [
        {
          marketPredictionId: 'market-prediction-1',
          marketKey: 'MATCH_RESULT',
          marketName: 'Match Result',
          selectionKey: 'HOME_WIN',
          selectionName: 'Home Win',
          probability: 0.75,
          confidence: 82,
          dataQuality: 0.8,
          decimalOdds: 1.6,
          fairOdds: 1.333333,
          priceType: 'PROVIDER',
          oddsUpdatedAt,
          oddsBasis: 'BOOKMAKER_ONLY',
          oddsCalculationMethod: 'ODDS_MODULE_PROVIDER_QUOTE',
          oddsProvider: 'THE_ODDS_API',
          bookmaker: 'Test Bookmaker',
          isFinalSelection: true,
          recommendationEligible: true,
          oddsPredictionReady: true,
          rankingScore: 0.8,
          safetyScore: 0.8,
        },
      ],
    };

    const pickRead = query([pick]);
    const existingRead = query([]);
    const activeDraftRead = query([]);
    const updatedPrediction = { _id: 'curated-1', eventId: 'fixture-1' };
    const writeQuery = query(updatedPrediction);

    const pickCenterModel = {
      find: jest.fn().mockReturnValue(pickRead),
    };
    const curatedPredictionModel = {
      find: jest
        .fn()
        .mockImplementation((filter: Record<string, any>) =>
          filter.eventId?.$in ? existingRead : activeDraftRead,
        ),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn().mockReturnValue(writeQuery),
    };
    const monitor = {
      recordCuratedRefresh: jest.fn().mockResolvedValue(undefined),
    };

    const service = new CuratedPredictionService(
      pickCenterModel as any,
      curatedPredictionModel as any,
      monitor as any,
    );

    const result = await service.refreshFromPickCenter(true);

    expect(result).toMatchObject({ created: 1, updated: 0, matchesScanned: 1 });
    expect(pickCenterModel.find).toHaveBeenCalledTimes(1);
    expect(pickRead.select).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 1,
        fixtureDate: 1,
        selectedMarkets: 1,
        modelVersion: 1,
      }),
    );

    expect(curatedPredictionModel.find).toHaveBeenCalledTimes(2);
    expect(curatedPredictionModel.find.mock.calls[0][0]).toEqual({
      eventId: { $in: ['fixture-1'] },
    });
    expect(existingRead.select).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 1,
        predictionCode: 1,
        generatedDateKey: 1,
        status: 1,
        settlementStatus: 1,
        diagnostics: 1,
      }),
    );
    expect(curatedPredictionModel.findOne).not.toHaveBeenCalled();
    expect(curatedPredictionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(monitor.recordCuratedRefresh).toHaveBeenCalledTimes(1);
  });
});
