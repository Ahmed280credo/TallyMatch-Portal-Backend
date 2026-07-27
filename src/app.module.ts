import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DatabaseModule } from "./database/database.module.js";
import { validateEnv } from "./config/env.validation.js";
import { redisConnectionOptions } from "./config/redis-connection.js";
import { InvoicesModule } from "./invoices/invoices.module.js";
import { ImportModule } from "./import/import.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionOptions(config.getOrThrow<string>("REDIS_URL"))
      })
    }),
    DatabaseModule,
    InvoicesModule,
    ImportModule
  ]
})
export class AppModule {}

