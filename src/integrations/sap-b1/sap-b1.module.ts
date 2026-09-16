import { Module } from "@nestjs/common";
import { SapB1SessionService } from "./sap-b1-session.service.js";
import { SapB1ClientService } from "./sap-b1-client.service.js";
import { SapB1ConnectorService } from "./sap-b1-connector.service.js";

// Not yet imported into AppModule — this is prep work ahead of live Spar
// FMCG credentials, not wired into the invoice pipeline yet. Once real
// credentials exist and the "push matched invoice to SAP B1" step is added
// to the pipeline, import SapB1Module into AppModule (or the module that
// needs it) the same way InvoicesModule/ImportModule already are.
@Module({
  providers: [SapB1SessionService, SapB1ClientService, SapB1ConnectorService],
  exports: [SapB1ConnectorService],
})
export class SapB1Module {}
