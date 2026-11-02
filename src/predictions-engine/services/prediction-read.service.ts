import { BadRequestException, Injectable } from '@nestjs/common';
import { PredictionAccessService } from '../../prediction-access/prediction-access.service';
import {
  AccessRequestUser,
  PredictionReadFilters,
} from '../../prediction-access/interfaces/prediction-access.interface';
import { PredictionMarket } from '../enums/prediction-market.enum';
import { PredictionStatus } from '../enums/prediction-status.enum';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';

/**
 * Compatibility facade for the existing prediction-engine routes. All reads
 * go through PredictionAccessService so raw market documents/slips cannot
 * bypass subscription entitlements or ranked market visibility.
 */
@Injectable()
export class PredictionReadService {
  constructor(private readonly access: PredictionAccessService) {}

  getMarketCatalog(): unknown {
    return FOOTBALL_MARKET_CATALOG.map((market) => ({
      ...market,
      selections: market.selections.map((selection) => ({ ...selection })),
    }));
  }

  listMarkets(
    input: PredictionReadFilters = {},
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    this.validateMarketFilters(input);
    return this.access.listMarkets(input, user);
  }

  getFixtureMarkets(
    eventId: string,
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>[]> {
    return this.access.getFixtureMarkets(eventId, user);
  }

  listPickCenter(
    input: PredictionReadFilters = {},
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    return this.access.listPickCenter(input, user);
  }

  getPickCenter(
    eventId: string,
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    return this.access.getPickCenter(eventId, user);
  }

  listSlips(
    input: {
      from?: string;
      to?: string;
      productType?: string;
      automatic?: boolean;
      page?: number;
      pageSize?: number;
      includeDrafts?: boolean;
      status?: string;
    } = {},
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    // Draft and cancelled slips are not exposed; automatic READY slips are accessible when entitled.
    return this.access.listSlips(
      {
        from: input.from,
        to: input.to,
        productType: input.productType,
        automatic: input.automatic,
        page: input.page,
        pageSize: input.pageSize,
      },
      user,
    );
  }

  getSlip(
    slipId: string,
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    return this.access.getSlip(slipId, user);
  }

  private validateMarketFilters(input: PredictionReadFilters): void {
    if (
      input.marketKey?.trim() &&
      !Object.values(PredictionMarket).includes(
        input.marketKey as PredictionMarket,
      )
    ) {
      throw new BadRequestException(`Unknown marketKey "${input.marketKey}".`);
    }
    if (
      input.status?.trim() &&
      String(input.status) !== String(PredictionStatus.CALCULATED)
    ) {
      throw new BadRequestException(
        'Active public markets support only CALCULATED status. Use the settled-history endpoint for results.',
      );
    }
    if (input.minimumProbability !== undefined) {
      const value = Number(input.minimumProbability);
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new BadRequestException(
          'minimumProbability must be between 0 and 1.',
        );
    }
    if (input.minimumConfidence !== undefined) {
      const value = Number(input.minimumConfidence);
      if (!Number.isFinite(value) || value < 0 || value > PREDICTION_ENGINE_CONFIG.model.maximumConfidence)
        throw new BadRequestException(
          `minimumConfidence must be between 0 and ${PREDICTION_ENGINE_CONFIG.model.maximumConfidence}.`,
        );
    }
  }
}



