import { Injectable, Logger } from "@nestjs/common";
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
// which mirrors mock-sap-b1/types.ts — pointing SAP_B1_BASE_URL at the real
// Service Layer instead of the mock (see sap-b1.config.ts) is the only change
// needed to go live once Spar FMCG's credentials are available.
@Injectable()
export class SapB1ConnectorService {
  private readonly logger = new Logger(SapB1ConnectorService.name);

  constructor(private readonly client: SapB1ClientService) {}

  // ── 1. Push a matched invoice into SAP B1 as a Purchase Invoice ─────────
  async pushPurchaseInvoice(input: CreatePurchaseInvoiceInput): Promise<PurchaseInvoice> {
    const invoice = await this.client.post<PurchaseInvoice>("/PurchaseInvoices", input);
    this.logger.log(
      `Pushed Purchase Invoice DocEntry=${invoice.DocEntry} DocNum=${invoice.DocNum} for ${input.CardCode}`
    );
    return invoice;
  }

  // ── 2. Read POs and GRNs (Purchase Delivery Notes) for 3-way matching ───
  async fetchPurchaseOrders(): Promise<PurchaseOrder[]> {
    const res = await this.client.get<ODataListResponse<PurchaseOrder>>("/PurchaseOrders");
    return res.value;
  }

  async fetchPurchaseDeliveryNotes(): Promise<PurchaseDeliveryNote[]> {
    const res = await this.client.get<ODataListResponse<PurchaseDeliveryNote>>("/PurchaseDeliveryNotes");
    return res.value;
  }

  async fetchPurchaseOrder(docEntry: number): Promise<PurchaseOrder> {
    return this.client.get<PurchaseOrder>(`/PurchaseOrders(${docEntry})`);
  }

  // ── 3. Poll a pushed invoice's payment/reconciliation status ────────────
  // The client pays from within their own SAP B1, not from TallyMatch — this
  // is how we find out it happened. Callers are expected to poll this on a
  // schedule (e.g. a cron job) per DocEntry they're tracking and update the
  // corresponding invoices row's status to "paid" when it returns true.
  async fetchPurchaseInvoiceStatus(docEntry: number): Promise<{
    invoice: PurchaseInvoice;
    isPaid: boolean;
  }> {
    const invoice = await this.client.get<PurchaseInvoice>(`/PurchaseInvoices(${docEntry})`);
    return { invoice, isPaid: isPurchaseInvoicePaid(invoice) };
  }
}
