import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { SystemMonitorStorageService } from './system-monitor-storage.service';
import { SystemMonitorService } from './system-monitor.service';

const DEEP_MODULES = new Set(['database', 'payments', 'payment-gateways', 'subscriptions', 'settlement', 'predictions-engine', 'sports', 'bet-lab', 'telegram']);
const CRITICAL_MODULES = new Set(['database', 'payments', 'payment-gateways', 'subscriptions', 'settlement', 'predictions-engine', 'sports']);
const INTERNAL_MODULES = new Set(['internalcoremodule', 'mongoosecoremodule', 'configmodule', 'confighostmodule', 'schedulemodule', 'discoverymodule', 'routermodule']);

@Injectable()
export class SystemMonitorHealthService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SystemMonitorHealthService.name);
  private databaseTimer?: ReturnType<typeof setInterval>;
  private storageTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly modules: ModulesContainer,
    private readonly monitor: SystemMonitorService,
    private readonly storage: SystemMonitorStorageService,
  ) {}

  onApplicationBootstrap(): void {
    for (const moduleRef of this.modules.values()) {
      const moduleName = (moduleRef as any)?.metatype?.name as string | undefined;
      if (!moduleName || !moduleName.endsWith('Module')) continue;
      const compact = moduleName.toLowerCase();
      if (INTERNAL_MODULES.has(compact)) continue;
      const key = this.toKebab(moduleName.replace(/Module$/, ''));
      const level = DEEP_MODULES.has(key) ? 'deep' : 'health';
      this.monitor.registerModule(key, level, CRITICAL_MODULES.has(key));
      const currentHealth = this.monitor.getModuleHealth(key);
      // Bootstrap discovery must not overwrite a health result reported by a worker
      // or a module lifecycle hook that ran earlier.
      if (!currentHealth || currentHealth.status === 'UNKNOWN') {
        this.monitor.reportModuleHealth(key, 'UNKNOWN', {
          source: 'nest-lifecycle',
          message: 'Nest module initialized; operational health has not yet been verified.',
        });
      }
    }
    const applicationHealth = this.monitor.getModuleHealth('application');
    if (!applicationHealth || applicationHealth.status === 'UNKNOWN') {
      this.monitor.reportModuleHealth('application', 'UNKNOWN', {
        source: 'nest-lifecycle',
        message: 'Application bootstrap completed; operational health checks are pending.',
      });
    }
    void this.checkDatabase();
    // Detailed database health/stats are expensive; direct checks remain available on demand.
    this.databaseTimer = setInterval(() => void this.checkDatabase(), 60 * 60_000);
    this.databaseTimer.unref?.();
    this.storageTimer = setInterval(() => {
      void this.storage.refreshStorageSnapshot().catch((error) => {
        this.logger.warn(`Scheduled database storage scan failed: ${this.errorMessage(error)}`);
      });
    }, 30 * 60_000);
    this.storageTimer.unref?.();
    // An early snapshot helps diagnose deployment storage without waiting for an admin page view.
    setTimeout(() => void this.storage.getStorageStats().catch((error) => this.logger.warn(`Initial storage scan failed: ${this.errorMessage(error)}`)), 20_000);
  }

  onModuleDestroy(): void {
    if (this.databaseTimer) clearInterval(this.databaseTimer);
    if (this.storageTimer) clearInterval(this.storageTimer);
  }

  private async checkDatabase() {
    try {
      await this.storage.getDatabaseHealth(true);
    } catch (error) {
      this.monitor.reportModuleHealth('database', 'FAILED', { source: 'database-probe', message: this.errorMessage(error) });
    }
  }
  private toKebab(name: string) { return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase(); }
  private errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
}

