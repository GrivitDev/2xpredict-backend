import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export interface SportsNewsImage {
  id?: number | string;
  type?: string;
  name?: string;
  caption?: string;
  alt?: string;
  credit?: string;
  width?: number;
  height?: number;
  url: string;
}

@Schema({ timestamps: true, collection: 'sports_news_articles', versionKey: false })
export class SportsNewsArticle {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ type: Number, index: true })
  espnArticleId?: number;

  @Prop({ trim: true, index: true })
  nowId?: string;

  @Prop({ trim: true })
  contentKey?: string;

  @Prop({ required: true, trim: true })
  headline!: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ type: String, trim: true, index: true })
  type?: string;

  @Prop({ type: Date, index: true })
  publishedAt?: Date;

  @Prop({ type: Date })
  lastModifiedAt?: Date;

  /** Automatically expire recent-news records 30 days after publication. */
  @Prop({ type: Date })
  expiresAt?: Date;

  @Prop({ type: String })
  byline?: string;

  @Prop({ type: [Object], default: [] })
  images!: SportsNewsImage[];

  @Prop({ type: [Object], default: [] })
  categories!: Array<Record<string, unknown>>;

  @Prop({ type: String, trim: true })
  canonicalUrl?: string;

  @Prop({ type: String })
  apiUrl?: string;

  @Prop({ type: String })
  mobileUrl?: string;

  @Prop({ type: Boolean, default: false, index: true })
  premium!: boolean;

  @Prop({ type: String, enum: ['SOCCER', 'LEAGUE', 'SUMMARY'], required: true, index: true })
  collectionScope!: 'SOCCER' | 'LEAGUE' | 'SUMMARY';

  @Prop({ type: [String], enum: ['SOCCER', 'LEAGUE', 'SUMMARY'], default: [], index: true })
  collectionScopes!: Array<'SOCCER' | 'LEAGUE' | 'SUMMARY'>;

  @Prop({ type: String, index: true })
  competitionId?: string;

  @Prop({ type: [String], default: [], index: true })
  competitionIds!: string[];

  @Prop({ type: [String], default: [], index: true })
  teamIds!: string[];

  @Prop({ type: [String], default: [], index: true })
  athleteIds!: string[];

  @Prop({ type: [String], default: [], index: true })
  fixtureIds!: string[];

  @Prop({ type: Object })
  source?: Record<string, unknown>;

  @Prop({ type: Object })
  rawPayload?: Record<string, unknown>;

  createdAt!: Date;
  updatedAt!: Date;
}

export type SportsNewsArticleDocument = HydratedDocument<SportsNewsArticle>;
export const SportsNewsArticleSchema = SchemaFactory.createForClass(SportsNewsArticle);
SportsNewsArticleSchema.index({ publishedAt: -1, id: -1 });
SportsNewsArticleSchema.index({ competitionId: 1, publishedAt: -1 });
SportsNewsArticleSchema.index({ teamIds: 1, publishedAt: -1 });
SportsNewsArticleSchema.index({ canonicalUrl: 1 }, { unique: true, sparse: true });
SportsNewsArticleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_1' });


