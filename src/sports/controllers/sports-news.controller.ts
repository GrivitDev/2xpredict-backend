import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { SportsNewsCollectionService } from '../services/sports-news-collection.service';

type NewsScope = 'SOCCER' | 'LEAGUE' | 'SUMMARY';
const NEWS_SCOPES: NewsScope[] = ['SOCCER', 'LEAGUE', 'SUMMARY'];

/** Read-only ESPN soccer news API. Collection remains queue-driven. */
@Controller('sports/v2/news')
export class SportsNewsController {
  constructor(private readonly news: SportsNewsCollectionService) {}

  @Get()
  getNews(
    @Query('competitionId') competitionId?: string,
    @Query('teamId') teamId?: string,
    @Query('scope') scope?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const parsedScope = scope?.trim().toUpperCase() as NewsScope | undefined;
    if (parsedScope && !NEWS_SCOPES.includes(parsedScope)) throw new BadRequestException(`Unsupported news scope: ${scope}`);
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException('limit must be a positive integer.');
    }
    const parsedBefore = before ? new Date(before) : undefined;
    if (parsedBefore && Number.isNaN(parsedBefore.getTime())) throw new BadRequestException('Invalid before date.');
    return this.news.getNews({ competitionId, teamId, scope: parsedScope, limit: parsedLimit, before: parsedBefore });
  }

  @Get(':articleId')
  getArticle(@Param('articleId') articleId: string) {
    return this.news.getNewsArticle(articleId);
  }
}
