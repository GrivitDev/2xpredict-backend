import { BadRequestException } from '@nestjs/common';

/**
 * Password policy shared by DTO validation and service-level validation.
 * bcrypt only uses the first 72 UTF-8 bytes, so passwords longer than that
 * are rejected instead of silently being treated as equivalent.
 */
export const PASSWORD_POLICY_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9\s])[!-~]{10,72}$/;

export const PASSWORD_POLICY_MESSAGE =
  'Password must be 10–72 characters, contain no spaces, and include uppercase, lowercase, a number, and a symbol.';

export function assertPasswordPolicy(password: string): void {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') > 72 ||
    !PASSWORD_POLICY_PATTERN.test(password)
  ) {
    throw new BadRequestException(PASSWORD_POLICY_MESSAGE);
  }
}

