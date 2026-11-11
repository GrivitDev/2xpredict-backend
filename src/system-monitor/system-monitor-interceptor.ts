import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, finalize, Observable, throwError } from 'rxjs';
import { resolveSystemMonitorControllerModule } from './system-monitor-module-registry';
import { SystemMonitorService } from './system-monitor.service';

@Injectable()
export class SystemMonitorInterceptor implements NestInterceptor {
  constructor(private readonly monitor: SystemMonitorService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<any>();
    const response = context.switchToHttp().getResponse<any>();
    const startedAt = Date.now();
    const controllerName = String(context.getClass()?.name ?? 'unknown');
    const operation = `${String(request?.method ?? 'HTTP').toUpperCase()} ${String(context.getHandler()?.name ?? 'handler')}`;
    const moduleName = resolveSystemMonitorControllerModule(controllerName);
    let recorded = false;

    return next.handle().pipe(
      catchError((error: unknown) => {
        const statusCode = typeof (error as any)?.getStatus === 'function'
          ? Number((error as any).getStatus())
          : 500;
        this.monitor.recordHttpRequest(
          moduleName,
          operation,
          statusCode,
          Date.now() - startedAt,
        );
        recorded = true;
        return throwError(() => error);
      }),
      finalize(() => {
        if (recorded) return;
        const statusCode = Number(response?.statusCode ?? 200);
        this.monitor.recordHttpRequest(
          moduleName,
          operation,
          statusCode,
          Date.now() - startedAt,
        );
      }),
    );
  }
}
