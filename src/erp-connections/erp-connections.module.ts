import { Module } from "@nestjs/common";
import { SapB1Module } from "../integrations/sap-b1/sap-b1.module.js";
import { ErpConnectionsController } from "./erp-connections.controller.js";
import { ErpConnectionsService } from "./erp-connections.service.js";
import { ErpConnectionsRepository } from "./erp-connections.repository.js";
import { ErpCredentialsCryptoService } from "./erp-credentials-crypto.service.js";

@Module({
  imports: [SapB1Module],
  controllers: [ErpConnectionsController],
  providers: [ErpConnectionsService, ErpConnectionsRepository, ErpCredentialsCryptoService],
  exports: [ErpConnectionsService],
})
export class ErpConnectionsModule {}
