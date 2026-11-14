import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { realtimeCorsOptions } from './realtime/realtime-cors';

const DEFAULT_FRONTEND_URL = 'https://www.2xpredict.com';

function normalizeFrontendUrl(logger: Logger): void {
  const configuredUrl =
    process.env.FRONTEND_URL?.trim() || DEFAULT_FRONTEND_URL;

  try {
    const url = new URL(configuredUrl);

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('FRONTEND_URL must use HTTP or HTTPS.');
    }

    const isLocalhost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
      url.hostname.toLowerCase(),
    );

    if (
      process.env.NODE_ENV === 'production' &&
      (url.protocol !== 'https:' || isLocalhost)
    ) {
      logger.warn(
        'Invalid production FRONTEND_URL detected. Using the canonical production frontend URL.',
      );

      process.env.FRONTEND_URL = DEFAULT_FRONTEND_URL;
      return;
    }

    // Store only the normalized origin, without a trailing slash or path.
    process.env.FRONTEND_URL = url.origin;
  } catch {
    logger.warn(
      'Invalid FRONTEND_URL detected. Using the canonical production frontend URL.',
    );

    process.env.FRONTEND_URL = DEFAULT_FRONTEND_URL;
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // ConfigModule.forRoot() is loaded through AppModule before bootstrap runs.
  // Normalize FRONTEND_URL before NestJS instantiates application providers.
  normalizeFrontendUrl(logger);

  const app = await NestFactory.create(AppModule, { rawBody: true });

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

  // HTTP and Socket.IO now share the same approved origin configuration.
  app.enableCors(realtimeCorsOptions);

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
