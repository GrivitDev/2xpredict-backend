import { UnauthorizedException } from '@nestjs/common';

export function authenticatedUserId(user: unknown): string {
  if (!user || typeof user !== 'object') throw new UnauthorizedException('Authentication is required');
  const record = user as Record<string, unknown>;
  const raw = record.userId ?? record._id ?? record.id ?? record.sub;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new UnauthorizedException('Authenticated user ID is missing');
  }
  return String(raw);
}
