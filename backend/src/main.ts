// backend/src/main.ts - Update CORS and static file serving
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Get frontend URLs from environment
  const frontendUrl =
    configService.get('FRONTEND_URL') || process.env.FRONTEND_URL;
  const ngrokUrl = process.env.FRONTEND_URL;

  // Enable CORS for multiple origins
  app.enableCors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like file requests)
      if (!origin) return callback(null, true);

      const allowedOrigins = [
        'http://localhost:3000',
        'https://narthecal-nonjudicially-carita.ngrok-free.dev',
        'https://habeshaprompt.loca.lt',
        'http://localhost:4060',
        'https://localhost:3000',
      ];

      if (
        allowedOrigins.indexOf(origin) !== -1 ||
        origin.includes('localhost') ||
        origin.includes('ngrok-free.dev') ||
        origin.includes('loca.lt')
      ) {
        console.log(`CORS allowed origin: ${origin}`);
        callback(null, true);
      } else {
        console.log(`CORS blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-telegram-init-data',
      'Accept',
      'X-Requested-With',
      'Origin',
      'Access-Control-Allow-Headers',
    ],
    exposedHeaders: ['Authorization', 'Content-Disposition'],
  });

  // Add logging middleware for static files
  app.use('/uploads', (req, res, next) => {
    logger.log(`📁 Static file request: ${req.method} ${req.url}`);
    next();
  });

  // IMPORTANT: Serve static files from the root uploads directory
  const uploadsDir = join(process.cwd(), 'uploads');
  app.useStaticAssets(uploadsDir, {
    prefix: '/uploads/',
    index: false,
    setHeaders: (res, path) => {
      // Set proper headers for images
      if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
        res.setHeader('Content-Type', 'image/jpeg');
      } else if (path.endsWith('.png')) {
        res.setHeader('Content-Type', 'image/png');
      } else if (path.endsWith('.webp')) {
        res.setHeader('Content-Type', 'image/webp');
      } else if (path.endsWith('.gif')) {
        res.setHeader('Content-Type', 'image/gif');
      }
      // Enable caching for images
      res.setHeader('Cache-Control', 'public, max-age=31536000');
    },
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global prefix
  app.setGlobalPrefix('api');

  const port = process.env.PORT || configService.get<number>('PORT') || 8080;
  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 Server is running on: http://localhost:${port}`);
  logger.log(`📝 API available at: http://localhost:${port}/api`);
  logger.log(`📁 Static files at: http://localhost:${port}/uploads/`);
  logger.log(`🌐 CORS enabled for: ${frontendUrl}, ${ngrokUrl}`);
}
bootstrap();
