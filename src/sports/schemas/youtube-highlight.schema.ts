import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

import { YoutubeHighlightStatus } from '../interfaces/youtube-highlight.interface';

export type YouTubeHighlightDocument = HydratedDocument<YouTubeHighlight>;

@Schema({
  timestamps: true,
  collection: 'sports_youtube_highlights',
})
export class YouTubeHighlight {
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  fixtureId!: string;

  @Prop({
    type: String,
    trim: true,
    index: true,
  })
  competitionId?: string;

  @Prop({
    required: true,
    trim: true,
  })
  homeTeam!: string;

  @Prop({
    required: true,
    trim: true,
  })
  awayTeam!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(YoutubeHighlightStatus),
    default: YoutubeHighlightStatus.PENDING,
    index: true,
  })
  status!: YoutubeHighlightStatus;

  @Prop({
    required: true,
    default: 0,
    min: 0,
  })
  retryCount!: number;

  @Prop({
    type: Date,
    index: true,
  })
  searchedAt?: Date;

  @Prop({
    type: Date,
    index: true,
  })
  nextRetryAt?: Date;

  @Prop({
    type: String,
    index: true,
    trim: true,
  })
  videoId?: string;

  @Prop({
    type: String,
    trim: true,
  })
  videoUrl?: string;

  @Prop({
    type: String,
  })
  title?: string;

  @Prop({
    type: String,
  })
  channelId?: string;

  @Prop({
    type: String,
  })
  channelTitle?: string;

  @Prop({
    type: Date,
  })
  publishedAt?: Date;

  @Prop({
    type: String,
  })
  thumbnailUrl?: string;

  @Prop({
    type: Object,
  })
  payload?: Record<string, unknown>;

  @Prop({
    type: String,
  })
  error?: string;
}

export const YouTubeHighlightSchema =
  SchemaFactory.createForClass(YouTubeHighlight);

YouTubeHighlightSchema.index({
  status: 1,
  nextRetryAt: 1,
  createdAt: 1,
});

YouTubeHighlightSchema.index({
  competitionId: 1,
  status: 1,
});

