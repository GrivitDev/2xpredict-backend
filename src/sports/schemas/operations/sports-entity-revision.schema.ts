import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsSourceEntity } from '../../interfaces/sports-derived-data.interface';

export type SportsEntityRevisionDocument = HydratedDocument<SportsEntityRevision>;

/**
 * Per-source-entity monotonic revision counter.
 * Updated in the same MongoDB transaction as the normalized source document
 * and its SportsDataChangeEvent outbox record.
 */
@Schema({ timestamps: true, collection: 'sports_entity_revisions', versionKey: false })
export class SportsEntityRevision {
  @Prop({
    required: true,
    type: String,
    enum: [
      'COMPETITION',
      'SEASON',
      'TEAM',
      'VENUE',
      'ATHLETE',
      'FIXTURE',
      'MATCH_STATISTICS',
      'MATCH_LINEUP',
      'TEAM_ROSTER',
      'MATCH_TIMELINE',
      'MATCH_ODDS',
    ],
    index: true,
  })
  entity!: SportsSourceEntity;

  @Prop({ required: true, trim: true, index: true })
  entityId!: string;

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  revision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsEntityRevisionSchema = SchemaFactory.createForClass(SportsEntityRevision);
SportsEntityRevisionSchema.index({ entity: 1, entityId: 1 }, { unique: true });

