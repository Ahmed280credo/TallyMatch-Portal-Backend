import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { validateEnv } from "../config/env.validation.js";
import { redisConnectionOptions } from "../config/redis-connection.js";
import { DatabaseModule } from "../database/database.module.js";
import { invoiceProviders } from "./invoices.providers.js";
import { ExtractAndMatchProcessor } from "./queues/extract-and-match.processor.js";
import { EXTRACT_AND_MATCH_QUEUE } from "./queues/invoice-queue.constants.js";

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
    BullModule.registerQueue({
      name: EXTRACT_AND_MATCH_QUEUE
    }),
    DatabaseModule
  ],
  providers: [...invoiceProviders, ExtractAndMatchProcessor]
})
export class InvoiceWorkerModule {}

