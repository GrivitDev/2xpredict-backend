import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { catchError, finalize, Observable, throwError } from 'rxjs';
import { SystemMonitorService } from './system-monitor.service';

@Injectable()
export class SystemMonitorInterceptor implements NestInterceptor {
  constructor(private readonly monitor: SystemMonitorService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<any>();
    const response = context.switchToHttp().getResponse<any>();
    const startedAt = Date.now();
    const controllerName = String(context.getClass()?.name ?? 'unknown').replace(/Controller$/, '');
    const operation = `${String(request?.method ?? 'HTTP').toUpperCase()} ${String(context.getHandler()?.name ?? 'handler')}`;
    const moduleName = this.moduleFromController(controllerName);
    let recorded = false;

    return next.handle().pipe(
      catchError((error: unknown) => {
        const statusCode = typeof (error as any)?.getStatus === 'function' ? Number((error as any).getStatus()) : 500;
        this.monitor.recordHttpRequest(moduleName, operation, statusCode, Date.now() - startedAt);
        recorded = true;
        return throwError(() => error);
      }),
      finalize(() => {
        if (recorded) return;
        const statusCode = Number(response?.statusCode ?? 200);
        this.monitor.recordHttpRequest(moduleName, operation, statusCode, Date.now() - startedAt);
      }),
    );
  }

  private moduleFromController(raw: string): string {
    const name = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const aliases: Array<[string, string]> = [
      ['websiteanalytics', 'website-analytics'], ['paymentgateways', 'payment-gateways'],
      ['predictionsread', 'predictions-engine'], ['predictionengine', 'predictions-engine'],
      ['predictionaccess', 'prediction-access'], ['settlement', 'settlement'],
      ['subscriptions', 'subscriptions'], ['payments', 'payments'], ['betlab', 'bet-lab'],
      ['sports', 'sports'], ['adminads', 'ads'], ['internalads', 'internal-ads'], ['ads', 'ads'],
      ['adminusers', 'users'], ['users', 'users'], ['auth', 'auth'], ['otp', 'otp'],
      ['referrals', 'referrals'], ['promos', 'promos'],
      ['telegram', 'telegram'], ['analytics', 'analytics'], ['usersession', 'user-session'],
    ];
    for (const [prefix, module] of aliases) if (name.startsWith(prefix)) return module;
    return raw.replace(/Controller$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() || 'unknown';
  }
}
