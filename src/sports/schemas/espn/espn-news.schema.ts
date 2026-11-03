import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EspnNewsDocument = HydratedDocument<EspnNews>;
export type EspnNewsKind = 'NEWS' | 'VIDEO';

@Schema({
  timestamps: true,
  collection: 'sports_espn_news',
})
export class EspnNews {
  /**
   * Stable ID derived from the normalized headline and content kind.
   * This makes repeated appearances of the same item across fixture summaries
   * resolve to one MongoDB document.
   */
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  articleId!: string;

  @Prop({
    type: String,
    unique: true,
    sparse: true,
    index: true,
    trim: true,
  })
  contentId?: string;

  @Prop({
    type: String,
    index: true,
    trim: true,
    lowercase: true,
  })
  normalizedHeadline?: string;

  @Prop({
    required: true,
    index: true,
    trim: true,
    lowercase: true,
  })
  leagueId!: string;

  @Prop({ type: [String], default: [], index: true })
  leagueIds!: string[];

  @Prop({ type: [String], default: [], index: true })
  eventIds!: string[];

  @Prop({ type: [String], default: [], index: true })
  teamIds!: string[];

  @Prop({ type: String, trim: true, index: true })
  eventId?: string;

  @Prop({ type: String, trim: true })
  homeTeamId?: string;

  @Prop({ type: String, trim: true })
  awayTeamId?: string;

  @Prop({ type: Date, index: true })
  fixtureDate?: Date;

  @Prop({
    required: true,
    type: String,
    enum: ['NEWS', 'VIDEO'],
    default: 'NEWS',
    index: true,
  })
  kind!: EspnNewsKind;

  @Prop({ type: String, trim: true })
  headline?: string;

  @Prop({ type: String })
  description?: string;

  /** Original provider publication timestamp, when supplied. */
  @Prop({ type: Date })
  published?: Date;

  @Prop({ type: Date })
  lastModified?: Date;

  /**
   * Effective feed date: original publication date, falling back to
   * lastModified only when the provider did not supply a publication date.
   */
  @Prop({ required: true, type: Date, index: true })
  feedPublishedAt!: Date;

  @Prop({ type: String })
  link?: string;

  @Prop({ type: String })
  imageUrl?: string;

  @Prop({ type: String })
  type?: string;

  @Prop({ type: String })
  author?: string;

  @Prop({ type: String, index: true })
  sourceArticleId?: string;

  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ required: true, type: Date, index: true })
  collectedAt!: Date;
}

export const EspnNewsSchema = SchemaFactory.createForClass(EspnNews);

/*
 * Feed queries sort by the effective publication date and commonly filter by
 * content kind, competition, or team. These compound indexes keep those reads
 * inside MongoDB instead of rescanning fixture summaries in Node.
 */
EspnNewsSchema.index({ feedPublishedAt: -1, _id: 1 });
EspnNewsSchema.index({ kind: 1, feedPublishedAt: -1 });
EspnNewsSchema.index({ leagueIds: 1, kind: 1, feedPublishedAt: -1 });
EspnNewsSchema.index({ teamIds: 1, kind: 1, feedPublishedAt: -1 });

