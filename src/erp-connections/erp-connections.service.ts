import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ErpConnectionsRepository } from "./erp-connections.repository.js";
import { ErpCredentialsCryptoService } from "./erp-credentials-crypto.service.js";
import { SapB1SessionService } from "../integrations/sap-b1/sap-b1-session.service.js";
import { SapB1ConnectorService } from "../integrations/sap-b1/sap-b1-connector.service.js";
import { mapLineItems } from "../integrations/sap-b1/sap-b1-mapping.js";
import type { SapB1Config } from "../integrations/sap-b1/sap-b1.config.js";
import { SapB1Error } from "../integrations/sap-b1/sap-b1.types.js";
import { SUPABASE_CLIENT } from "../database/supabase.client.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ErpConnectionStatus } from "../invoices/types/database.js";

export interface UpsertErpConnectionDto {
  erp_type?: string;
  base_url: string;
  company_db?: string | null;
  username: string;
  password: string;
}

// Never includes the password — this is the only shape the frontend ever
// sees for a connection.
export interface ErpConnectionStatusResponse {
  configured: boolean;
  erp_type: string | null;
  base_url: string | null;
  company_db: string | null;
  username: string | null;
  status: ErpConnectionStatus | null;
  status_message: string | null;
  last_tested_at: string | null;
  last_sync_at: string | null;
}

export interface TestConnectionResult {
  success: boolean;
  status: ErpConnectionStatus;
  message: string | null;
}

export interface SyncResult {
  purchase_orders_synced: number;
  purchase_delivery_notes_synced: number;
  synced_at: string;
}

@Injectable()
export class ErpConnectionsService {
  private readonly logger = new Logger(ErpConnectionsService.name);

  constructor(
    private readonly repository: ErpConnectionsRepository,
    private readonly crypto: ErpCredentialsCryptoService,
    private readonly sapB1Session: SapB1SessionService,
    private readonly sapB1Connector: SapB1ConnectorService,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient
  ) {}

  async getStatus(orgId: string): Promise<ErpConnectionStatusResponse> {
    const connection = await this.repository.getByOrgId(orgId);
    if (!connection) {
      return {
        configured: false,
        erp_type: null,
        base_url: null,
        company_db: null,
        username: null,
        status: null,
        status_message: null,
        last_tested_at: null,
        last_sync_at: null,
      };
    }
    return {
      configured: true,
      erp_type: connection.erp_type,
      base_url: connection.base_url,
      company_db: connection.company_db,
      username: connection.username,
      status: connection.status,
      status_message: connection.status_message,
      last_tested_at: connection.last_tested_at,
      last_sync_at: connection.last_sync_at,
    };
  }

  async upsertConnection(orgId: string, dto: UpsertErpConnectionDto): Promise<ErpConnectionStatusResponse> {
    if (!dto.base_url?.trim()) throw new BadRequestException("base_url is required");
    if (!dto.username?.trim()) throw new BadRequestException("username is required");
    if (!dto.password?.trim()) throw new BadRequestException("password is required");

    const passwordEncrypted = this.crypto.encrypt(dto.password);

    // New credentials are unverified until "Test Connection" is run again —
    // reset to disconnected rather than leaving a stale "connected" status
    // from the previous credentials.
    await this.repository.upsert(orgId, {
      erp_type: dto.erp_type ?? "sap_b1",
      base_url: dto.base_url.trim(),
      company_db: dto.company_db?.trim() || null,
      username: dto.username.trim(),
      password_encrypted: passwordEncrypted,
      status: "disconnected",
      status_message: null,
    });

    // Any cached session for this org's old credentials is now stale.
    this.sapB1Session.invalidate(orgId);

    return this.getStatus(orgId);
  }

  async testConnection(orgId: string): Promise<TestConnectionResult> {
    const config = await this.getConfigForOrg(orgId);

    // Force a fresh login attempt rather than reusing whatever's cached —
    // "Test Connection" should reflect the current credentials right now.
    this.sapB1Session.invalidate(orgId);

    try {
      await this.sapB1Session.getCookieHeader(config, orgId);
      await this.repository.update(orgId, {
        status: "connected",
        status_message: null,
        last_tested_at: new Date().toISOString(),
      });
      return { success: true, status: "connected", message: null };
    } catch (err) {
      const message = err instanceof SapB1Error ? err.message : err instanceof Error ? err.message : "Unknown error";
      await this.repository.update(orgId, {
        status: "error",
        status_message: message,
        last_tested_at: new Date().toISOString(),
      });
      return { success: false, status: "error", message };
    }
  }

  // Used by the invoice push flow — throws if no connection is configured,
  // since pushing an invoice without ERP credentials is a hard error, not
  // something to degrade gracefully from.
  async getConfigForOrg(orgId: string): Promise<SapB1Config> {
    const connection = await this.repository.getByOrgId(orgId);
    if (!connection) {
      throw new NotFoundException("No ERP connection configured for this organization");
    }
    return {
      baseUrl: connection.base_url,
      companyDB: connection.company_db ?? "",
      userName: connection.username,
      password: this.crypto.decrypt(connection.password_encrypted),
    };
  }

  // Pulls POs and GRNs from SAP B1 and upserts them into TallyMatch's own
  // purchase_orders/goods_receipt_notes tables (source='erp_sync'), so they
  // sit alongside manually-entered and CSV-imported records and 3-way
  // matching picks them up without any change to the matching engine.
  async syncNow(orgId: string): Promise<SyncResult> {
    const config = await this.getConfigForOrg(orgId);

    const pos = await this.sapB1Connector.fetchPurchaseOrders(config, orgId);
    if (pos.length > 0) {
      const poRecords = pos.map((po) => ({
        org_id: orgId,
        po_number: String(po.DocNum),
        vendor_name: po.CardName,
        total_amount: po.DocTotal,
        currency: null,
        line_items: mapLineItems(po.DocumentLines),
        source: "erp_sync" as const,
        erp_type: "sap_b1",
        erp_doc_entry: po.DocEntry,
        erp_doc_num: po.DocNum,
      }));
      const { error } = await this.supabase
        .from("purchase_orders")
        .upsert(poRecords, { onConflict: "org_id,po_number" });
      if (error) throw new Error(`Failed to sync purchase orders: ${error.message}`);
    }

    const grns = await this.sapB1Connector.fetchPurchaseDeliveryNotes(config, orgId);
    if (grns.length > 0) {
      const poByDocEntry = new Map(pos.map((p) => [p.DocEntry, p]));
      const grnRecords = grns.map((grn) => {
        const baseEntry = grn.DocumentLines[0]?.BaseEntry;
        const basePo = baseEntry != null ? poByDocEntry.get(baseEntry) : undefined;
        return {
          org_id: orgId,
          grn_number: String(grn.DocNum),
          po_number: basePo ? String(basePo.DocNum) : null,
          vendor_name: grn.CardName,
          total_received_amount: grn.DocTotal,
          line_items: mapLineItems(grn.DocumentLines),
          received_at: grn.DocDate,
          source: "erp_sync" as const,
          erp_type: "sap_b1",
          erp_doc_entry: grn.DocEntry,
          erp_doc_num: grn.DocNum,
        };
      });
      const { error } = await this.supabase
        .from("goods_receipt_notes")
        .upsert(grnRecords, { onConflict: "org_id,grn_number" });
      if (error) throw new Error(`Failed to sync purchase delivery notes: ${error.message}`);
    }

    const syncedAt = new Date().toISOString();
    await this.repository.update(orgId, { last_sync_at: syncedAt });

    this.logger.log(`Synced ${pos.length} POs and ${grns.length} GRNs for org ${orgId}`);
    return { purchase_orders_synced: pos.length, purchase_delivery_notes_synced: grns.length, synced_at: syncedAt };
  }
}
