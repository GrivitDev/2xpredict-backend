import type { NextFunction, Request, Response } from 'express';

/** Shared symbol used to read the byte count from the response interceptor. */
export const HTTP_DELIVERY_BYTE_COUNT = Symbol.for(
  '2xpredict.systemMonitor.httpDeliveryByteCount',
);

type InstrumentedResponse = Response & {
  [HTTP_DELIVERY_BYTE_COUNT]?: () => number;
};

function getStringEncoding(value: unknown): BufferEncoding | undefined {
  if (typeof value !== 'string' || !Buffer.isEncoding(value)) {
    return undefined;
  }

  return value as BufferEncoding;
}

function getChunkBytes(chunk: unknown, encoding?: BufferEncoding): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, encoding);
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk.byteLength;
  }

  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }

  return 0;
}

/**
 * Counts response-body bytes at the Node ServerResponse boundary.
 * Register this middleware before compression middleware so it observes the
 * bytes emitted after compression, without retaining or inspecting payloads.
 */
export function httpDeliveryByteCounterMiddleware(
  _request: Request,
  response: InstrumentedResponse,
  next: NextFunction,
): void {
  let responseBytes = 0;
  const rawResponse = response as any;
  const originalWrite = rawResponse.write;
  const originalEnd = rawResponse.end;

  rawResponse[HTTP_DELIVERY_BYTE_COUNT] = () => responseBytes;

  rawResponse.write = function (...args: any[]) {
    responseBytes += getChunkBytes(args[0], getStringEncoding(args[1]));
    return originalWrite.apply(this, args);
  };

  rawResponse.end = function (...args: any[]) {
    responseBytes += getChunkBytes(args[0], getStringEncoding(args[1]));
    return originalEnd.apply(this, args);
  };

  next();
}
