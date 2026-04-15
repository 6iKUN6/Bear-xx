import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { createSwaggerDocument } from './swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors();

  const document = createSwaggerDocument(app);
  SwaggerModule.setup('api-docs', app, document);

  const preferredPort = Number(process.env.PORT) || 3000;
  let port = preferredPort;

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await app.listen(port);
      console.log(`Litter-Bear Server running on http://localhost:${port}`);
      console.log(`API Docs: http://localhost:${port}/api-docs`);
      return;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ) {
        console.warn(`Port ${port} is in use, trying ${port + 1}...`);
        port++;
      } else {
        throw err;
      }
    }
  }

  throw new Error(
    `Could not find an available port (tried ${preferredPort}-${port - 1})`,
  );
}

bootstrap()
  .then(() => {})
  .catch(() => {});
