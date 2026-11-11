type ProviderRequestErrorDetails = {
  provider: string;
  endpoint: string;
  statusCode?: number;
  retryable: boolean;
};

export class SportsProviderRequestError extends Error {
  readonly provider: ProviderRequestErrorDetails['provider'];
  readonly endpoint: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    details: ProviderRequestErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SportsProviderRequestError';
    this.provider = details.provider;
    this.endpoint = details.endpoint;
    this.statusCode = details.statusCode;
    this.retryable = details.retryable;
  }
}
