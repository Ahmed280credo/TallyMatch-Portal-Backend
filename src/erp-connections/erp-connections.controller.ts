import { Body, Controller, Get, Post, Put, UseGuards } from "@nestjs/common";
import { SupabaseAuthGuard } from "../auth/supabase-auth.guard.js";
import { OrgId } from "../common/decorators/org-id.decorator.js";
import { ErpConnectionsService, type UpsertErpConnectionDto } from "./erp-connections.service.js";

@Controller(["v1/integrations/erp", "integrations/erp"])
@UseGuards(SupabaseAuthGuard)
export class ErpConnectionsController {
  constructor(private readonly service: ErpConnectionsService) {}

  @Get("connection")
  getConnection(@OrgId() orgId: string) {
    return this.service.getStatus(orgId);
  }

  @Put("connection")
  upsertConnection(@OrgId() orgId: string, @Body() dto: UpsertErpConnectionDto) {
    return this.service.upsertConnection(orgId, dto);
  }

  @Post("connection/test")
  testConnection(@OrgId() orgId: string) {
    return this.service.testConnection(orgId);
  }

  @Post("sync")
  sync(@OrgId() orgId: string) {
    return this.service.syncNow(orgId);
  }
}
