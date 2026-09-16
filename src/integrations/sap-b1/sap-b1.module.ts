import { Module } from "@nestjs/common";
import { SapB1SessionService } from "./sap-b1-session.service.js";
import { SapB1ClientService } from "./sap-b1-client.service.js";
import { SapB1ConnectorService } from "./sap-b1-connector.service.js";

@Module({
  providers: [SapB1SessionService, SapB1ClientService, SapB1ConnectorService],
  // SapB1SessionService is exported alongside the connector because
  // ErpConnectionsService needs it directly for "Test Connection" (a raw
  // login attempt, not a PO/GRN/Invoice operation the connector exposes).
  exports: [SapB1ConnectorService, SapB1SessionService],
})
export class SapB1Module {}
