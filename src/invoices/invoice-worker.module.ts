import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { validateEnv } from "../config/env.validation.js";
import { redisConnectionOptions } from "../config/redis-connection.js";
import { DatabaseModule } from "../database/database.module.js";
import { invoiceProviders } from "./invoices.providers.js";
import { ExtractAndMatchProcessor } from "./queues/extract-and-match.processor.js";
import { EXTRACT_AND_MATCH_QUEUE } from "./queues/invoice-queue.constants.js";
import { ErpConnectionsModule } from "../erp-connections/erp-connections.module.js";
import { SapB1Module } from "../integrations/sap-b1/sap-b1.module.js";

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
    DatabaseModule,
    // ErpPushService (already in invoiceProviders from earlier ERP work) needs
    // SapB1ConnectorService directly, and BundleAssemblyService (Phase 1)
    // needs ErpConnectionsService to check whether an org has a connected ERP
    // (erp vs paper_only extraction mode — a read-only status check, not a
    // change to the connector itself). Neither was ever wired into this
    // worker module, which left it unable to boot at all as soon as
    // ErpPushService joined invoiceProviders — found while verifying Phase 1
    // boots cleanly, fixed here rather than left broken.
    SapB1Module,
    ErpConnectionsModule
  ],
  providers: [...invoiceProviders, ExtractAndMatchProcessor]
})
export class InvoiceWorkerModule {}

