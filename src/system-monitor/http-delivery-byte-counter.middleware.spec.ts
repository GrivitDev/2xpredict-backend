import {
  HTTP_DELIVERY_BYTE_COUNT,
  httpDeliveryByteCounterMiddleware,
} from './http-delivery-byte-counter.middleware';

describe('HTTP delivery byte counter middleware', () => {
  it('counts string, Buffer and Uint8Array response chunks without retaining them', () => {
    const originalWrite = jest.fn(() => true);
    const originalEnd = jest.fn(() => response);
    const response: any = {
      write: originalWrite,
      end: originalEnd,
    };
    const next = jest.fn();

    httpDeliveryByteCounterMiddleware({} as any, response, next);

    response.write('hello');
    response.write(Buffer.from([1, 2, 3]));
    response.end(new Uint8Array([4, 5]));

    expect(next).toHaveBeenCalledTimes(1);
    expect(response[HTTP_DELIVERY_BYTE_COUNT]()).toBe(10);
    // The middleware intentionally replaces response.write/end with wrappers.
    // Assert against the original Node response methods, not those wrappers.
    expect(originalWrite).toHaveBeenCalledTimes(2);
    expect(originalEnd).toHaveBeenCalledTimes(1);
  });

  it('uses a valid string encoding when calculating byte counts', () => {
    const originalWrite = jest.fn(() => true);
    const originalEnd = jest.fn(() => response);
    const response: any = {
      write: originalWrite,
      end: originalEnd,
    };

    httpDeliveryByteCounterMiddleware({} as any, response, jest.fn());

    response.write('é', 'latin1');
    response.end('é', 'utf8');

    expect(response[HTTP_DELIVERY_BYTE_COUNT]()).toBe(3);
    expect(originalWrite).toHaveBeenCalledWith('é', 'latin1');
    expect(originalEnd).toHaveBeenCalledWith('é', 'utf8');
  });

  it('does not count missing or unsupported chunks', () => {
    const originalWrite = jest.fn(() => true);
    const originalEnd = jest.fn(() => response);
    const response: any = {
      write: originalWrite,
      end: originalEnd,
    };

    httpDeliveryByteCounterMiddleware({} as any, response, jest.fn());
    response.write(undefined);
    response.end();

    expect(response[HTTP_DELIVERY_BYTE_COUNT]()).toBe(0);
    expect(originalWrite).toHaveBeenCalledWith(undefined);
    expect(originalEnd).toHaveBeenCalledWith();
  });
});
