import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type SportsCalculatedStandingsDocument =
  HydratedDocument<SportsCalculatedStandingsModel>;

@Schema({
  timestamps: true,
  collection: 'sports_calculated_standings',
  versionKey: false,
})
export class SportsCalculatedStandingsModel {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ required: true, trim: true, index: true })
  seasonId!: string;

  @Prop({
    required: true,
    type: [MongooseSchema.Types.Mixed],
    default: [],
  })
  entries!: unknown[];

  @Prop({ required: true, type: Date, index: true })
  computedAt!: Date;

  @Prop({ required: true, type: Number, min: 0, index: true })
  sourceRevision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsCalculatedStandingsSchema = SchemaFactory.createForClass(
  SportsCalculatedStandingsModel,
);
SportsCalculatedStandingsSchema.index(
  { competitionId: 1, seasonId: 1 },
  { unique: true },
);
SportsCalculatedStandingsSchema.index({
  competitionId: 1,
  seasonId: 1,
  'entries.position': 1,
});
