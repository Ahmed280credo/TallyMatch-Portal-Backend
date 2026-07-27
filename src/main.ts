import "reflect-metadata";
import helmet from "helmet";
import { NestFactory } from "@nestjs/core";

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "ECONNRESET") return;
  console.error("Uncaught exception", err);
  process.exit(1);
});
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>("PORT");
  const corsOrigin = config.getOrThrow<string>("CORS_ORIGIN");

  app.use(helmet());
  app.enableCors({
    origin: corsOrigin,
    credentials: true
  });

  await app.listen(port);
}

void bootstrap();

