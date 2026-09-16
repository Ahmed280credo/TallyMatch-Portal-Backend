import { Injectable, Logger } from "@nestjs/common";
import type { SapB1Config } from "./sap-b1.config.js";
import { SapB1ClientService } from "./sap-b1-client.service.js";
import {
  isPurchaseInvoicePaid,
  type CreatePurchaseInvoiceInput,
  type PurchaseDeliveryNote,
  type PurchaseInvoice,
  type PurchaseOrder,
} from "./sap-b1.types.js";

interface ODataListResponse<T> {
  value: T[];
}

// High-level SAP B1 Service Layer operations TallyMatch actually needs.
// Everything below is written against src/integrations/sap-b1/sap-b1.types.ts,
// which mirrors mock-sap-b1/types.ts — every method takes the caller's
// SapB1Config (per-org, looked up from erp_connections) plus a cacheKey
// (the org id) so sessions/requests are correctly scoped per organization.
@Injectable()
export class SapB1ConnectorService {
  private readonly logger = new Logger(SapB1ConnectorService.name);

  constructor(private readonly client: SapB1ClientService) {}

  // ── 1. Push a matched invoice into SAP B1 as a Purchase Invoice ─────────
  async pushPurchaseInvoice(
    config: SapB1Config,
    cacheKey: string,
    input: CreatePurchaseInvoiceInput
  ): Promise<PurchaseInvoice> {
    const invoice = await this.client.post<PurchaseInvoice>(config, cacheKey, "/PurchaseInvoices", input);
    this.logger.log(
      `Pushed Purchase Invoice DocEntry=${invoice.DocEntry} DocNum=${invoice.DocNum} for ${input.CardCode}`
    );
    return invoice;
  }

  // ── 2. Read POs and GRNs (Purchase Delivery Notes) for 3-way matching ───
  async fetchPurchaseOrders(config: SapB1Config, cacheKey: string): Promise<PurchaseOrder[]> {
    const res = await this.client.get<ODataListResponse<PurchaseOrder>>(config, cacheKey, "/PurchaseOrders");
    return res.value;
  }

  async fetchPurchaseDeliveryNotes(config: SapB1Config, cacheKey: string): Promise<PurchaseDeliveryNote[]> {
    const res = await this.client.get<ODataListResponse<PurchaseDeliveryNote>>(
      config,
      cacheKey,
      "/PurchaseDeliveryNotes"
    );
    return res.value;
  }

  async fetchPurchaseOrder(config: SapB1Config, cacheKey: string, docEntry: number): Promise<PurchaseOrder> {
    return this.client.get<PurchaseOrder>(config, cacheKey, `/PurchaseOrders(${docEntry})`);
  }

  async fetchPurchaseDeliveryNote(
    config: SapB1Config,
    cacheKey: string,
    docEntry: number
  ): Promise<PurchaseDeliveryNote> {
    return this.client.get<PurchaseDeliveryNote>(config, cacheKey, `/PurchaseDeliveryNotes(${docEntry})`);
  }

  // ── 3. Poll a pushed invoice's payment/reconciliation status ────────────
  // The client pays from within their own SAP B1, not from TallyMatch — this
  // is how we find out it happened. Callers are expected to poll this on a
  // schedule per DocEntry they're tracking and update the corresponding
  // invoices row's status to "paid" when it returns true.
  async fetchPurchaseInvoiceStatus(
    config: SapB1Config,
    cacheKey: string,
    docEntry: number
  ): Promise<{ invoice: PurchaseInvoice; isPaid: boolean }> {
    const invoice = await this.client.get<PurchaseInvoice>(config, cacheKey, `/PurchaseInvoices(${docEntry})`);
    return { invoice, isPaid: isPurchaseInvoicePaid(invoice) };
  }
}
