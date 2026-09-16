import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { EXTRACT_AND_MATCH_QUEUE } from "./queues/invoice-queue.constants.js";
import { InvoicesController } from "./invoices.controller.js";
import { invoiceProviders } from "./invoices.providers.js";
import { SupabaseAuthGuard } from "../auth/supabase-auth.guard.js";
import { SapB1Module } from "../integrations/sap-b1/sap-b1.module.js";
import { ErpConnectionsModule } from "../erp-connections/erp-connections.module.js";

@Module({
  imports: [
    SapB1Module,
    ErpConnectionsModule,
    BullModule.registerQueueAsync({
      name: EXTRACT_AND_MATCH_QUEUE,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: () => ({
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000
          },
          removeOnComplete: {
            age: 86400,
            count: 1000
          },
          removeOnFail: {
            age: 604800
          }
        }
      })
    })
  ],
  controllers: [InvoicesController],
  providers: [...invoiceProviders, SupabaseAuthGuard],
  exports: invoiceProviders
})
export class InvoicesModule {}

