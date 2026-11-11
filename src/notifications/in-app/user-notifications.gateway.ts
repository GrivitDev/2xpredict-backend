import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { UserSessionService } from '../../user-session/user-session.service';
import { UserStatus } from '../../users/schemas/user.schema';

interface AuthenticatedNotificationSocket extends Socket {
  data: Socket['data'] & { userId?: string };
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return undefined;
  }
}

@WebSocketGateway({
  namespace: '/user-notifications',
  cors: {
    origin: (origin, callback) => {
      const allowed = [
        normalizeOrigin(process.env.FRONTEND_URL),
        'https://www.2xpredict.com',
        'https://2xpredict.com',
        ...(process.env.NODE_ENV === 'production'
          ? []
          : ['http://localhost:3000']),
      ].filter((item): item is string => Boolean(item));

      if (!origin || allowed.includes(origin)) callback(null, true);
      else callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
  },
})
export class UserNotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(UserNotificationsGateway.name);

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly sessionsService: UserSessionService,
    private readonly configService: ConfigService,
  ) {}

  afterInit(): void {
    this.logger.log('User notification namespace initialized.');
  }

  async handleConnection(client: AuthenticatedNotificationSocket): Promise<void> {
    try {
      const token = this.getToken(client);
      if (!token) return this.rejectConnection(client);

      const payload = await this.jwtService.verifyAsync<Record<string, unknown>>(
        token,
        { secret: this.configService.getOrThrow<string>('JWT_SECRET') },
      );

      const userId = typeof payload.userId === 'string' ? payload.userId : '';
      const sessionId =
        typeof payload.sessionId === 'string' ? payload.sessionId : '';
      if (!userId || !sessionId) return this.rejectConnection(client);

      const user = await this.usersService.findById(userId);
      if (
        !user ||
        user.isDeleted ||
        ![
          UserStatus.ACTIVE,
          ...(!user.isVerified ? [UserStatus.PENDING] : []),
        ].includes(user.status) ||
        (user.bannedUntil && user.bannedUntil > new Date())
      ) {
        return this.rejectConnection(client);
      }

      const session = await this.sessionsService.findSessionById(sessionId);
      if (!session || !session.isActive || String(session.userId) !== userId) {
        return this.rejectConnection(client);
      }

      client.data.userId = userId;
      await client.join(this.userRoom(userId));
      client.emit('notification:ready', {
        connected: true,
        connectedAt: new Date().toISOString(),
      });
    } catch {
      this.rejectConnection(client);
    }
  }

  handleDisconnect(_client: Socket): void {
    // Do not log tokens, user IDs, socket IDs, or private connection data.
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    if (!this.server || !userId) return;
    this.server.to(this.userRoom(userId)).emit(event, payload);
  }

  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  private getToken(client: Socket): string | undefined {
    const authToken = client.handshake.auth?.token;
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
    this.logger.warn('Rejected unauthenticated user notification socket.');
    client.disconnect(true);
  }
}

