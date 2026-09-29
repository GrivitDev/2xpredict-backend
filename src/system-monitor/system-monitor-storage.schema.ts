import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

// ============================================================
// COLLECTION STAT
// ============================================================

@Schema({
  _id: false,
})
export class SystemMonitorStorageCollection {
  @Prop({
    required: true,
  })
  name!: string;

  @Prop({
    required: true,
    default: 0,
  })
  documents!: number;

  @Prop({
    required: true,
    default: 0,
  })
  dataSizeBytes!: number;

  @Prop({
    required: true,
    default: 0,
  })
  storageSizeBytes!: number;

  @Prop({
    required: true,
    default: 0,
  })
  averageDocumentSizeBytes!: number;

  @Prop({
    required: true,
    default: 0,
  })
  indexes!: number;

  @Prop({
    required: true,
    default: 0,
  })
  totalIndexSizeBytes!: number;

  @Prop({
    required: true,
    default: 0,
  })
  totalSizeBytes!: number;
}

export const SystemMonitorStorageCollectionSchema =
  SchemaFactory.createForClass(SystemMonitorStorageCollection);

// ============================================================
// STORAGE TOTALS
// ============================================================

@Schema({
  _id: false,
})
export class SystemMonitorStorageTotals {
  @Prop({
    required: true,
    default: 0,
  })
  collections!: number;

  @Prop({
    required: true,
    default: 0,
  })
  documents!: number;

  @Prop({
    required: true,
    default: 0,
  })
  dataSizeBytes!: number;

  @Prop({
    required: true,
    default: 0,
  })
  storageSizeBytes!: number;

  @Prop({
    required: true,
    default: 0,
  })
  indexSizeBytes!: number;

  @Prop({
    required: true,
    default: 0,
  })
  totalSizeBytes!: number;
}

export const SystemMonitorStorageTotalsSchema = SchemaFactory.createForClass(
  SystemMonitorStorageTotals,
);

// ============================================================
// STORAGE SNAPSHOT
// ============================================================

@Schema({
  collection: 'system_monitor_storage_snapshots',

  timestamps: false,

  versionKey: false,
})
export class SystemMonitorStorageSnapshot {
  @Prop({
    required: true,
    index: true,
  })
  capturedAt!: Date;

  @Prop({
    required: true,
  })
  databaseName!: string;

  @Prop({
    type: SystemMonitorStorageTotalsSchema,

    required: true,
  })
  totals!: SystemMonitorStorageTotals;

  @Prop({
    type: [SystemMonitorStorageCollectionSchema],

    default: [],
  })
  collections!: SystemMonitorStorageCollection[];
}

export type SystemMonitorStorageSnapshotDocument =
  HydratedDocument<SystemMonitorStorageSnapshot>;

export const SystemMonitorStorageSnapshotSchema = SchemaFactory.createForClass(
  SystemMonitorStorageSnapshot,
);

// ============================================================
// INDEX
// ============================================================

SystemMonitorStorageSnapshotSchema.index({
  capturedAt: -1,
});
