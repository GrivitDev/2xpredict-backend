import compression from 'compression';

/**
 * Keep API response compression bounded and avoid buffering live event streams.
 * The compression package negotiates gzip/deflate/Brotli from Accept-Encoding.
 */
export function shouldCompressHttpResponse(request: any, response: any): boolean {
  const contentType = String(
    response?.getHeader?.('Content-Type') ?? '',
  ).toLowerCase();

  // Compressing SSE can delay small event chunks unless each route explicitly
  // flushes the compression stream. Keep live event streams uncompressed.
  if (contentType.includes('text/event-stream')) return false;

  // Do not transform a response that another layer has already encoded.
  if (response?.getHeader?.('Content-Encoding')) return false;

  return compression.filter(request, response);
}

export function createHttpCompressionMiddleware() {
  return compression({
    // Avoid spending CPU on small JSON or text responses.
    threshold: 1024,
    // Prefer predictable CPU cost over maximum compression ratio.
    level: 4,
    filter: shouldCompressHttpResponse,
  });
}

export function isHttpCompressionEnabled(value?: string): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'disabled'].includes(normalized);
}
