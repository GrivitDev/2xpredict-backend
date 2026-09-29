import { Global, Module } from '@nestjs/common';

import { MongooseModule } from '@nestjs/mongoose';

import { SystemMonitorController } from './system-monitor.controller';

import { SystemMonitorService } from './system-monitor.service';

import { SystemMonitorStorageService } from './system-monitor-storage.service';

import {
  SystemMonitorStorageSnapshot,
  SystemMonitorStorageSnapshotSchema,
} from './system-monitor-storage.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: SystemMonitorStorageSnapshot.name,

        schema: SystemMonitorStorageSnapshotSchema,
      },
    ]),
  ],

  controllers: [SystemMonitorController],

  providers: [SystemMonitorService, SystemMonitorStorageService],

  exports: [SystemMonitorService, SystemMonitorStorageService],
})
export class SystemMonitorModule {}
