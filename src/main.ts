import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const logger = new Logger('Bootstrap');

  // Configure trusted reverse proxies.
  const trustProxyHopsValue = process.env.TRUST_PROXY_HOPS;

  if (trustProxyHopsValue !== undefined) {
    const trustProxyHops = Number(trustProxyHopsValue);

    if (
      !Number.isInteger(trustProxyHops) ||
      trustProxyHops < 0 ||
      trustProxyHops > 5
    ) {
      throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
    }

    app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);
  }

  // Explicitly approved frontend origins.
  // localhost is intentionally allowed even in production so local
  // development can communicate with the production API.
  const configuredOrigins = [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGINS,
    'https://www.2xpredict.com',
    'https://2xpredict.com',
    'http://localhost:3000',
  ];

  const allowedOrigins = new Set(
    configuredOrigins
      .flatMap((value) => (value ?? '').split(','))
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value).origin;
        } catch {
          return value;
        }
      }),
  );

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ): void => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      logger.warn(`CORS request rejected from origin: ${origin}`);
      callback(null, false);
    },

    credentials: true,

    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

    optionsSuccessStatus: 204,
    maxAge: 86400,
  });

  app.use(helmet());

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  const portValue = process.env.PORT ?? '5000';
  const port = Number(portValue);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port number.');
  }

  await app.listen(port, '0.0.0.0');

  logger.log(`Backend listening on port ${port}`);
}

void bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');

  logger.error(error instanceof Error ? error.stack : String(error));

  process.exitCode = 1;
});
