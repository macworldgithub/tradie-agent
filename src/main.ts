import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;

  app.useStaticAssets(join(__dirname, '..', 'public'));

  await app.listen(port);
  console.log(`Server running on http://localhost:${port}`);
}
void bootstrap();
