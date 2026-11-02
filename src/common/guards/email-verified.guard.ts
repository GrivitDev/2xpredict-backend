import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

interface AuthenticatedRequest {
  user?: { isVerified?: boolean };
}

@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthorizedException('Authentication is required.');
    }
    if (request.user.isVerified !== true) {
      throw new ForbiddenException(
        'Verify your email address before using this feature.',
      );
    }
    return true;
  }
}
