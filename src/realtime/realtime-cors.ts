function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;

  try {
    const url = new URL(value.trim());

    if (!['http:', 'https:'].includes(url.protocol)) {
      return undefined;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}

function getAllowedOrigins(): Set<string> {
  const configuredOrigins = [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGINS,
    'https://www.2xpredict.com',
    'https://2xpredict.com',
  ];

  const origins = configuredOrigins
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .map(normalizeOrigin)
    .filter((value): value is string => Boolean(value));

  return new Set(origins);
}

export const realtimeCorsOptions = {
  origin: (
    origin: string | undefined,
    callback: (error: Error | null, allow?: boolean) => void,
  ): void => {
    // Requests without an Origin header are allowed.
    // Browser origins are checked against the explicit whitelist.
    if (!origin) {
      callback(null, true);
      return;
    }

    const normalizedOrigin = normalizeOrigin(origin);
    const allowed = getAllowedOrigins();

    callback(null, Boolean(normalizedOrigin && allowed.has(normalizedOrigin)));
  },

  credentials: true,

  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

  optionsSuccessStatus: 204,

  maxAge: 86400,
};
