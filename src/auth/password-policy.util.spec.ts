import { BadRequestException } from '@nestjs/common';
import { assertPasswordPolicy } from './password-policy.util';

describe('assertPasswordPolicy', () => {
  it('accepts a password that satisfies every rule', () => {
    expect(() => assertPasswordPolicy('StrongPass9!')).not.toThrow();
  });

  it.each([
    'short9!A',
    'lowercase9!',
    'UPPERCASE9!',
    'NoNumber!!',
    'NoSymbol123',
    'Has space9!A',
    'A'.repeat(73) + '9!',
  ])('rejects an invalid password (%s)', (password) => {
    expect(() => assertPasswordPolicy(password)).toThrow(BadRequestException);
  });

  it('rejects passwords exceeding bcrypt 72-byte input limit', () => {
    const password = `${'A'.repeat(69)}9!é`;
    expect(Buffer.byteLength(password, 'utf8')).toBeGreaterThan(72);
    expect(() => assertPasswordPolicy(password)).toThrow(BadRequestException);
  });

  it('rejects non-string runtime input', () => {
    expect(() => assertPasswordPolicy(null as unknown as string)).toThrow(
      BadRequestException,
    );
  });
});
