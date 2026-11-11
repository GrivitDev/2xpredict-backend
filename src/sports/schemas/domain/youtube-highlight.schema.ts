import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsYoutubeHighlightRecord } from '../../interfaces/sports-youtube-highlight.interface';

export type SportsYoutubeHighlightDocument = HydratedDocument<SportsYoutubeHighlight>;

@Schema({ timestamps: true, collection: 'sports_youtube_highlights', versionKey: false })
export class SportsYoutubeHighlight implements Omit<SportsYoutubeHighlightRecord, 'createdAt' | 'updatedAt'> {
  @Prop({ required: true, unique: true, trim: true })
  fixtureId!: string;

  @Prop({ trim: true, index: true })
  competitionId?: string;

  @Prop({ required: true, trim: true })
  homeTeam!: string;

  @Prop({ required: true, trim: true })
  awayTeam!: string;

  @Prop({ required: true, type: String, enum: ['PENDING', 'SEARCHING', 'RETRY', 'FOUND', 'FAILED'], default: 'PENDING', index: true })
  status!: SportsYoutubeHighlightRecord['status'];

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  retryCount!: number;

  @Prop({ type: Date, index: true })
  searchedAt?: Date;

  @Prop({ type: Date, index: true })
  nextRetryAt?: Date;

  @Prop({ trim: true, index: true })
  videoId?: string;

  @Prop({ trim: true })
  videoUrl?: string;

  @Prop({ type: String })
  title?: string;

  @Prop({ trim: true })
  channelId?: string;

  @Prop({ type: String })
  channelTitle?: string;

  @Prop({ type: Date })
  publishedAt?: Date;

  @Prop({ trim: true })
  thumbnailUrl?: string;

  @Prop({ type: String })
  error?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsYoutubeHighlightSchema = SchemaFactory.createForClass(SportsYoutubeHighlight);
SportsYoutubeHighlightSchema.index({ status: 1, nextRetryAt: 1, createdAt: 1 });
SportsYoutubeHighlightSchema.index({ competitionId: 1, status: 1 });

