import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SportsYoutubeHighlight } from '../schemas/domain/youtube-highlight.schema';

type HighlightSortField = 'publishedAt' | 'createdAt';

/** Public, read-only projection of successfully collected YouTube highlights. */
@Controller('sports/v2/highlights')
export class SportsHighlightsController {
  constructor(
    @InjectModel(SportsYoutubeHighlight.name)
    private readonly highlightModel: Model<any>,
  ) {}

  @Get()
  async getHighlights(
    @Query('page') pageValue?: string,
    @Query('limit') limitValue?: string,
    @Query('competitionId') competitionId?: string,
    @Query('from') fromValue?: string,
    @Query('to') toValue?: string,
    @Query('sortBy') sortByValue?: string,
    @Query('sortOrder') sortOrderValue?: string,
  ) {
    const page = this.parseInteger(pageValue, 'page', 1);
    const limit = this.parseInteger(limitValue, 'limit', 30);
    if (limit > 100) throw new BadRequestException('limit cannot exceed 100.');

    const from = this.parseDate(fromValue, 'from');
    const to = this.parseDate(toValue, 'to');
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException(
        'from must be earlier than or equal to to.',
      );
    }

    const filter: Record<string, unknown> = {
      status: 'FOUND',
      videoId: { $exists: true, $nin: ['', null] },
    };
    const normalizedCompetitionId = competitionId?.trim();
    if (normalizedCompetitionId) filter.competitionId = normalizedCompetitionId;

    if (from || to) {
      const publishedAt: Record<string, Date> = {};
      if (from) publishedAt.$gte = from;
      if (to) publishedAt.$lte = to;
      filter.publishedAt = publishedAt;
    }

    const sortBy: HighlightSortField =
      sortByValue === 'createdAt' ? 'createdAt' : 'publishedAt';
    const sortDirection: 1 | -1 =
      sortOrderValue?.toLowerCase() === 'asc' ? 1 : -1;
    const sort: Record<string, 1 | -1> = {
      [sortBy]: sortDirection,
      _id: sortDirection,
    };
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.highlightModel
        .find(filter)
        .select({
          _id: 0,
          fixtureId: 1,
          competitionId: 1,
          homeTeam: 1,
          awayTeam: 1,
          videoId: 1,
          videoUrl: 1,
          title: 1,
          channelTitle: 1,
          publishedAt: 1,
          thumbnailUrl: 1,
          searchedAt: 1,
          createdAt: 1,
        })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.highlightModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    };
  }

  private parseInteger(
    value: string | undefined,
    field: string,
    fallback: number,
  ): number {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${field} must be a positive integer.`);
    }
    return parsed;
  }

  private parseDate(
    value: string | undefined,
    field: string,
  ): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
      throw new BadRequestException(`Invalid ${field} date.`);
    return parsed;
  }
}
