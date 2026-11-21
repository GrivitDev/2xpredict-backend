import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, Subscription } from 'rxjs';
import { resolveSystemMonitorControllerModule } from './system-monitor-module-registry';
import { HTTP_DELIVERY_BYTE_COUNT } from './http-delivery-byte-counter.middleware';
import { SystemMonitorHttpDeliveryService } from './system-monitor-http-delivery.service';
import { SystemMonitorPerformanceService } from './system-monitor-performance.service';
import { SystemMonitorRequestContextService } from './system-monitor-request-context.service';
import { SystemMonitorService } from './system-monitor.service';

@Injectable()
export class SystemMonitorInterceptor implements NestInterceptor {
  constructor(
    private readonly monitor: SystemMonitorService,
    private readonly performanceMonitor: SystemMonitorPerformanceService,
    private readonly requestContext: SystemMonitorRequestContextService,
    private readonly httpDeliveryMonitor: SystemMonitorHttpDeliveryService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<any>();
    const response = context.switchToHttp().getResponse<any>();
    const startedAt = process.hrtime.bigint();

    const controllerName = String(context.getClass()?.name ?? 'unknown');
    const handlerName = String(context.getHandler()?.name ?? 'handler');
    const method = String(request?.method ?? 'HTTP').toUpperCase();
    const operation = `${method} ${handlerName}`;
    const performanceOperation = `${method} ${controllerName}.${handlerName}`;
    const moduleName = resolveSystemMonitorControllerModule(controllerName);

    const requestMetrics = {
      module: moduleName,
      operation: performanceOperation,
      databaseOperations: 0,
      databaseCompletedOperations: 0,
      databaseDurationMs: 0,
      slowDatabaseOperations: 0,
      databaseFailures: 0,
    };

    let recorded = false;
    let deliveryRecorded = false;

    const recordRequest = (statusCode: number, aborted = false): void => {
      if (recorded) return;
      recorded = true;

      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const measuredBytes = response?.[HTTP_DELIVERY_BYTE_COUNT]?.();
      const declaredLength = Number(response?.getHeader?.('content-length'));
      const responseBytes = Number.isFinite(measuredBytes) && measuredBytes >= 0
        ? measuredBytes
        : Number.isFinite(declaredLength) && declaredLength >= 0
          ? declaredLength
          : null;
      const responseSizeSource = Number.isFinite(measuredBytes) && measuredBytes >= 0
        ? 'measured'
        : responseBytes !== null
          ? 'content-length'
          : 'unknown';

      this.monitor.recordHttpRequest(
        moduleName,
        operation,
        statusCode,
        durationMs,
      );

      this.performanceMonitor.recordHttpRequest(
        moduleName,
        performanceOperation,
        statusCode,
        durationMs,
        {
          databaseOperations: requestMetrics.databaseOperations,
          databaseCompletedOperations:
            requestMetrics.databaseCompletedOperations,
          databasePendingOperations: Math.max(
            0,
            requestMetrics.databaseOperations -
              requestMetrics.databaseCompletedOperations,
          ),
          databaseDurationMs: requestMetrics.databaseDurationMs,
          slowDatabaseOperations: requestMetrics.slowDatabaseOperations,
          databaseFailures: requestMetrics.databaseFailures,
          responseBytes,
          responseSizeSource,
          aborted,
        },
      );
    };

    const recordDelivery = (aborted: boolean): void => {
      if (deliveryRecorded) return;
      deliveryRecorded = true;

      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const measuredBytes = response?.[HTTP_DELIVERY_BYTE_COUNT]?.();
      const declaredLength = Number(response?.getHeader?.('content-length'));
      const responseBytes = Number.isFinite(measuredBytes) && measuredBytes >= 0
        ? measuredBytes
        : Number.isFinite(declaredLength) && declaredLength >= 0
          ? declaredLength
          : undefined;
      const rawEncoding = response?.getHeader?.('content-encoding');
      const statusCode = Number(response?.statusCode ?? (aborted ? 499 : 200));

      this.httpDeliveryMonitor.recordResponse({
        module: moduleName,
        operation: performanceOperation,
        statusCode,
        durationMs,
        responseBytes,
        contentEncoding:
          typeof rawEncoding === 'string' ? rawEncoding : undefined,
        aborted,
      });
    };

    if (response && typeof response.once === 'function') {
      response.once('finish', () => {
        recordRequest(Number(response.statusCode ?? 200), false);
        recordDelivery(false);
      });
      response.once('close', () => {
        if (!response.writableFinished) {
          const abortedStatus = response.headersSent
            ? Number(response.statusCode ?? 499)
            : 499;
          recordRequest(abortedStatus, true);
          recordDelivery(true);
        }
      });
    }

    // Keep MongoDB commands inside this request's AsyncLocalStorage scope.
    return new Observable<unknown>((subscriber) => {
      const subscription: Subscription = this.requestContext.run(
        requestMetrics,
        () =>
          next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (error: unknown) => subscriber.error(error),
            complete: () => subscriber.complete(),
          }),
      );

      return () => subscription.unsubscribe();
    });
  }
}
