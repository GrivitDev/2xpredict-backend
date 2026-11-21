import compression from 'compression';
import {
  isHttpCompressionEnabled,
  shouldCompressHttpResponse,
} from './http-compression';

describe('HTTP response compression configuration', () => {
  it('uses the standard compressible-content filter for JSON responses', () => {
    const request = { headers: { 'accept-encoding': 'gzip, br' } };
    const response = {
      getHeader: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : undefined,
    };

    expect(shouldCompressHttpResponse(request, response)).toBe(
      compression.filter(request as any, response as any),
    );
    expect(shouldCompressHttpResponse(request, response)).toBe(true);
  });

  it('does not compress server-sent event streams', () => {
    const request = { headers: { 'accept-encoding': 'gzip' } };
    const response = {
      getHeader: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'text/event-stream' : undefined,
    };

    expect(shouldCompressHttpResponse(request, response)).toBe(false);
  });

  it('does not attempt to compress an already encoded response', () => {
    const request = { headers: { 'accept-encoding': 'gzip' } };
    const response = {
      getHeader: (name: string) => {
        if (name.toLowerCase() === 'content-type') return 'application/json';
        if (name.toLowerCase() === 'content-encoding') return 'br';
        return undefined;
      },
    };

    expect(shouldCompressHttpResponse(request, response)).toBe(false);
  });

  it.each(['false', '0', 'off', 'disabled'])('allows HTTP compression to be disabled with %s', (value) => {
    expect(isHttpCompressionEnabled(value)).toBe(false);
  });

  it('enables HTTP compression by default', () => {
    expect(isHttpCompressionEnabled(undefined)).toBe(true);
    expect(isHttpCompressionEnabled('true')).toBe(true);
  });
});
