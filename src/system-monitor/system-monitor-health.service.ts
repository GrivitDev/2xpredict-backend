import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { AdminGateway } from '../realtime/admin.gateway';
import { getSystemMonitorModuleDefinition, resolveNestSystemMonitorModule } from './system-monitor-module-registry';
import { SystemMonitorStorageService } from './system-monitor-storage.service';
import { SystemMonitorService } from './system-monitor.service';

@Injectable()
export class SystemMonitorHealthService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SystemMonitorHealthService.name);
  private databaseTimer?: ReturnType<typeof setInterval>;
  private storageTimer?: ReturnType<typeof setInterval>;
  private storageInitialTimer?: ReturnType<typeof setTimeout>;
  private realtimeProbeTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  constructor(
    private readonly modules: ModulesContainer,
    private readonly monitor: SystemMonitorService,
    private readonly storage: SystemMonitorStorageService,
    private readonly adminGateway: AdminGateway,
  ) {}

  onApplicationBootstrap(): void {
    this.destroyed = false;
    const moduleGraph: Array<{ module: string; imports: string[] }> = [];

    for (const moduleRef of this.modules.values()) {
      const currentModule = moduleRef as unknown as {
        metatype?: { name?: string };
      };
      const moduleName = currentModule?.metatype?.name;
      if (!moduleName || !moduleName.endsWith('Module')) continue;

      const key = resolveNestSystemMonitorModule(moduleName);
      if (!key || key === 'application') continue;

      const imports: string[] = [];
      // Read the imports declared on @Module metadata, not moduleRef.imports.
      // Nest adds @Global modules to moduleRef.imports automatically; treating
      // those as explicit imports would create false dependency-graph drift.
      const declaredImports = (Reflect as any).getMetadata?.(
        'imports',
        currentModule.metatype,
      ) as unknown[] | undefined;

      for (const declaredImport of declaredImports ?? []) {
        let importedModule: unknown = declaredImport;

        // Resolve forwardRef(() => SomeModule) without relying on Nest's
        // internal ModuleRef.imports collection.
        if (
          importedModule &&
          typeof importedModule === 'object' &&
          typeof (importedModule as { forwardRef?: unknown }).forwardRef === 'function'
        ) {
          importedModule = (importedModule as { forwardRef: () => unknown }).forwardRef();
        }

        // DynamicModule declarations expose the owning class through .module.
        if (
          importedModule &&
          typeof importedModule === 'object' &&
          'module' in importedModule
        ) {
          importedModule = (importedModule as { module?: unknown }).module;
        }

        const importedName = typeof importedModule === 'function'
          ? (importedModule as { name?: string }).name
          : undefined;
        if (!importedName) continue;

        const importedKey = resolveNestSystemMonitorModule(importedName);
        if (importedKey && importedKey !== key) imports.push(importedKey);
      }

      moduleGraph.push({ module: key, imports: [...new Set(imports)] });
    }

    // AppModule and MongoDB are synthetic monitor nodes, not domain imports.
    // Domain import edges come from each module's declared @Module metadata.
    this.monitor.setDiscoveredModuleGraph(moduleGraph);

    const discovered = new Set(moduleGraph.map((entry) => entry.module));
    discovered.add('database');
    discovered.add('application');

    for (const key of discovered) {
      this.monitor.registerModule(key);
      const currentHealth = this.monitor.getModuleHealth(key);
      if (currentHealth && currentHealth.status !== 'UNKNOWN') continue;

      const definition = getSystemMonitorModuleDefinition(key);
      if (definition?.probeMode === 'LIFECYCLE') {
        this.monitor.reportModuleHealth(key, 'HEALTHY', {
          source: 'nest-lifecycle',
          message:
            'Nest module instantiated and dependency injection resolved. Database, worker and external-provider health are evaluated separately.',
          details: { lifecycleReady: true },
        });
      } else if (!currentHealth || currentHealth.status === 'UNKNOWN') {
        this.monitor.reportModuleHealth(key, 'UNKNOWN', {
          source: 'nest-lifecycle',
          message: 'Nest module discovered; its operational health probe has not yet completed.',
        });
      }
    }

    this.monitor.reportModuleHealth('application', 'HEALTHY', {
      source: 'nest-lifecycle',
      message: 'Nest application bootstrap completed; process-level telemetry is active.',
      details: { lifecycleReady: true },
    });

    // Periodic readiness probes are deliberately separated from expensive
    // storage inventory snapshots and from request-activity observations.
    void this.checkDatabase();
    this.databaseTimer = setInterval(() => void this.checkDatabase(), 60 * 60_000);
    this.databaseTimer.unref?.();

    this.storageTimer = setInterval(() => {
      void this.storage.refreshStorageSnapshot().catch((error) => {
        this.logger.warn(`Scheduled database storage scan failed: ${this.errorMessage(error)}`);
      });
    }, 30 * 60_000);
    this.storageTimer.unref?.();
    this.storageInitialTimer = setTimeout(() => {
      void this.storage.getStorageStats().catch((error) => {
        this.logger.warn(`Initial storage scan failed: ${this.errorMessage(error)}`);
      });
    }, 20_000);
    this.storageInitialTimer.unref?.();

    // The Gateway's afterInit hook is owned by Nest's WebSocket lifecycle.
    // Check that registration rather than assuming module discovery alone
    // proves the socket transport is ready.
    this.scheduleRealtimeProbe(1_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.databaseTimer) clearInterval(this.databaseTimer);
    if (this.storageTimer) clearInterval(this.storageTimer);
    if (this.storageInitialTimer) clearTimeout(this.storageInitialTimer);
    if (this.realtimeProbeTimer) clearTimeout(this.realtimeProbeTimer);
  }

  private async checkDatabase(): Promise<void> {
    try {
      await this.storage.getDatabaseHealth(true);
    } catch (error) {
      this.monitor.reportModuleHealth('database', 'FAILED', {
        source: 'database-probe',
        message: this.errorMessage(error),
      });
    }
  }

  private scheduleRealtimeProbe(delayMs: number): void {
    if (this.destroyed) return;
    if (this.realtimeProbeTimer) clearTimeout(this.realtimeProbeTimer);
    this.realtimeProbeTimer = setTimeout(() => {
      this.realtimeProbeTimer = undefined;
      this.checkRealtimeGateway();
    }, delayMs);
    this.realtimeProbeTimer.unref?.();
  }

  private checkRealtimeGateway(): void {
    if (this.destroyed) return;
    const gateway = this.adminGateway
      .getModuleStatuses()
      .find((entry) => entry.module === 'realtime-gateway');

    if (!gateway) {
      this.monitor.reportModuleHealth('realtime', 'UNKNOWN', {
        source: 'websocket-lifecycle',
        message: 'Waiting for the Admin WebSocket gateway afterInit lifecycle hook.',
      });
      this.scheduleRealtimeProbe(5_000);
      return;
    }

    const status = gateway.operationalStatus === 'FAILED'
      ? 'FAILED'
      : gateway.operationalStatus === 'DEGRADED'
        ? 'DEGRADED'
        : gateway.operationalStatus === 'READY'
          ? 'HEALTHY'
          : 'UNKNOWN';
    this.monitor.reportModuleHealth('realtime', status, {
      source: 'websocket-lifecycle',
      message: gateway.message,
      details: {
        gatewayRegistered: gateway.integrationStatus === 'READY',
        transport: 'socket.io',
        gatewayOperationalStatus: gateway.operationalStatus,
      },
    });

    if (status !== 'HEALTHY') this.scheduleRealtimeProbe(5_000);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
