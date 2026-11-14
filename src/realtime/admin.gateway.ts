import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { UsersService } from '../users/users.service';
import { UserSessionService } from '../user-session/user-session.service';
import { UserStatus } from '../users/schemas/user.schema';
import { realtimeCorsOptions } from './realtime-cors';

export type RealtimeModuleOperationalStatus =
  | 'READY'
  | 'STARTING'
  | 'DEGRADED'
  | 'FAILED'
  | 'STOPPED'
  | 'UNKNOWN';

export interface RealtimeModuleStatus {
  module: string;
  integrationStatus: 'READY' | 'FAILED';
  operationalStatus: RealtimeModuleOperationalStatus;
  message: string;
  registeredAt: string;
  updatedAt: string;
  lastEventAt?: string;
  eventCount: number;
  details?: Record<string, unknown>;
}

interface AuthenticatedSocket extends Socket {
  data: Record<string, unknown> & { adminUserId?: string };
}

@WebSocketGateway({
  cors: realtimeCorsOptions,
})
export class AdminGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(AdminGateway.name);
  private readonly moduleStatuses = new Map<string, RealtimeModuleStatus>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly sessionsService: UserSessionService,
  ) {}

  afterInit(): void {
    this.registerModule('realtime-gateway', {
      message:
        'Admin WebSocket gateway initialized and accepting authenticated admin connections.',
      operationalStatus: 'READY',
      details: { transport: 'socket.io', audience: 'admin' },
    });

    this.logger.log('Admin Realtime Gateway initialized successfully.');

    this.logger.log(
      `Realtime readiness registry currently contains ${this.moduleStatuses.size} module integrations.`,
    );
  }

  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    try {
      const token = this.getToken(client);

      if (!token) return this.rejectConnection(client);

      const payload =
        await this.jwtService.verifyAsync<Record<string, unknown>>(token);

      const userId = typeof payload.userId === 'string' ? payload.userId : '';

      if (!userId) return this.rejectConnection(client);

      const user = await this.usersService.findById(userId);

      if (
        !user ||
        String(user.role) !== 'admin' ||
        user.status !== UserStatus.ACTIVE ||
        user.isDeleted
      ) {
        return this.rejectConnection(client);
      }

      if (typeof payload.sessionId !== 'string' || !payload.sessionId) {
        return this.rejectConnection(client);
      }

      const session = await this.sessionsService.findSessionById(
        payload.sessionId,
      );

      if (!session || !session.isActive || String(session.userId) !== userId) {
        return this.rejectConnection(client);
      }

      client.data.adminUserId = userId;

      await client.join('admin');

      client.emit('realtime:ready', {
        connected: true,
        audience: 'admin',
        connectedAt: new Date().toISOString(),
        modules: this.getModuleStatuses(),
      });

      this.logger.log(
        'Authenticated admin dashboard connected to Realtime Gateway.',
      );
    } catch {
      this.rejectConnection(client);
    }
  }

  handleDisconnect(): void {
    // Do not log socket IDs, tokens, user IDs, or other connection details.
  }

  /** Register a module only after its provider successfully resolves during Nest bootstrap. */
  registerModule(
    moduleName: string,
    options: {
      message?: string;
      operationalStatus?: RealtimeModuleOperationalStatus;
      details?: Record<string, unknown>;
    } = {},
  ): void {
    const module = this.normalizeModuleName(moduleName);

    if (!module) return;

    const now = new Date().toISOString();
    const existing = this.moduleStatuses.get(module);

    const status: RealtimeModuleStatus = {
      module,
      integrationStatus: 'READY',
      operationalStatus:
        options.operationalStatus ?? existing?.operationalStatus ?? 'UNKNOWN',
      message: this.safeText(
        options.message ??
          existing?.message ??
          'Realtime integration initialized.',
        300,
      ),
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
      lastEventAt: existing?.lastEventAt,
      eventCount: existing?.eventCount ?? 0,
      details: options.details ?? existing?.details,
    };

    this.moduleStatuses.set(module, status);

    this.logger.log(
      `Realtime integration ready: ${module} (operational=${status.operationalStatus}).`,
    );

    this.server?.to('admin').emit('realtime:module-status', status);
  }

  /** Report actual health separately from successful WebSocket integration. */
  setModuleOperationalStatus(
    moduleName: string,
    operationalStatus: RealtimeModuleOperationalStatus,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const module = this.normalizeModuleName(moduleName);

    if (!module) return;

    if (!this.moduleStatuses.has(module)) {
      this.registerModule(module);
    }

    const current = this.moduleStatuses.get(module)!;

    const next: RealtimeModuleStatus = {
      ...current,
      operationalStatus,
      message: this.safeText(message, 300),
      updatedAt: new Date().toISOString(),
      details: details ? this.safeDetails(details) : current.details,
    };

    this.moduleStatuses.set(module, next);

    this.server?.to('admin').emit('realtime:module-status', next);

    if (operationalStatus === 'FAILED' || operationalStatus === 'DEGRADED') {
      this.logger.warn(
        `Realtime module status: ${module}=${operationalStatus}: ${next.message}`,
      );
    } else {
      this.logger.log(
        `Realtime module status: ${module}=${operationalStatus}.`,
      );
    }
  }

  /** Publish a namespaced event to authenticated admins only. */
  publishModuleEvent(
    moduleName: string,
    eventName: string,
    payload: unknown,
  ): void {
    const module = this.normalizeModuleName(moduleName);
    const event = this.safeEventName(eventName);

    if (!module || !event) return;

    if (!this.moduleStatuses.has(module)) {
      this.registerModule(module, {
        message:
          'Realtime event received; operational health has not yet been verified.',
        operationalStatus: 'UNKNOWN',
        details: { integration: 'event-observed' },
      });
    }

    const current = this.moduleStatuses.get(module);

    if (current) {
      const next: RealtimeModuleStatus = {
        ...current,
        lastEventAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        eventCount: current.eventCount + 1,
      };

      this.moduleStatuses.set(module, next);

      this.server?.to('admin').emit('realtime:module-status', next);
    }

    this.server?.to('admin').emit(event, payload);
  }

  getModuleStatuses(): RealtimeModuleStatus[] {
    return [...this.moduleStatuses.values()].sort((a, b) =>
      a.module.localeCompare(b.module),
    );
  }

  emitNewPayment(payment: unknown): void {
    this.publishModuleEvent(
      'payments',
      'payment:new',
      this.safePaymentPayload(payment),
    );
  }

  emitPaymentUpdate(payment: unknown): void {
    this.publishModuleEvent(
      'payments',
      'payment:update',
      this.safePaymentPayload(payment),
    );
  }

  emitAnalyticsUpdate(data: unknown): void {
    this.publishModuleEvent('website-analytics', 'analytics:update', data);
  }

  private getToken(client: Socket): string | undefined {
    const authToken = (
      client.handshake.auth as Record<string, unknown> | undefined
    )?.token;

    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken.trim();
    }

    const header = client.handshake.headers.authorization;

    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7).trim();
    }

    return undefined;
  }

  private rejectConnection(client: Socket): void {
    this.logger.warn(
      'Rejected unauthenticated or unauthorized Realtime connection.',
    );

    client.disconnect(true);
  }

  private normalizeModuleName(value: string): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 80);
  }

  private safeEventName(value: string): string {
    const event = String(value ?? '').trim();

    return /^[a-z0-9][a-z0-9:_-]{1,79}$/i.test(event) ? event : '';
  }

  private safeText(value: string, max: number): string {
    return String(value ?? '')
      .replace(/[\r\n\t]/g, ' ')
      .slice(0, max);
  }

  private safeDetails(value: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      if (/token|password|secret|authorization|cookie|credential/i.test(key)) {
        continue;
      }

      if (
        item === null ||
        ['string', 'number', 'boolean'].includes(typeof item)
      ) {
        output[key] =
          typeof item === 'string' ? this.safeText(item, 200) : item;
      }
    }

    return output;
  }

  private safePaymentPayload(value: unknown): Record<string, unknown> {
    const payment =
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};

    const toText = (item: unknown): string | undefined => {
      if (typeof item === 'string') {
        const text = item.trim();
        return text ? text : undefined;
      }

      if (typeof item === 'number' || typeof item === 'boolean') {
        return String(item);
      }

      return undefined;
    };

    const toId = (item: unknown): string | undefined => {
      if (typeof item === 'string' || typeof item === 'number') {
        return String(item);
      }

      if (typeof item === 'boolean') {
        return item ? 'true' : 'false';
      }

      if (item instanceof Date) {
        return item.toISOString();
      }

      return undefined;
    };

    const pickDate = (date: unknown) =>
      date instanceof Date
        ? date.toISOString()
        : typeof date === 'string'
          ? date
          : undefined;

    return {
      id: toId(payment._id),
      reference: toText(payment.reference),
      userId: toId(payment.userId),
      email: toText(payment.email),
      type: toText(payment.type),
      target: toText(payment.target),
      amount: typeof payment.amount === 'number' ? payment.amount : undefined,
      currency: toText(payment.currency),
      gateway: toText(payment.gateway),
      status: toText(payment.status),
      createdAt: pickDate(payment.createdAt),
      processedAt: pickDate(payment.processedAt),
    };
  }
}
