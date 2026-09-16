import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AccountsPayableRepository } from "./accounts-payable.repository.js";
import { AuditLogService } from "./audit-log.service.js";
import { ErpConnectionsService } from "../../erp-connections/erp-connections.service.js";
import { SapB1ConnectorService } from "../../integrations/sap-b1/sap-b1-connector.service.js";
import { SAP_B1_OBJECT_TYPE, SapB1Error } from "../../integrations/sap-b1/sap-b1.types.js";
import type { Invoice } from "../types/database.js";

const AMOUNT_TOLERANCE = 1;

// Pushes a matched invoice into the org's connected ERP (SAP B1 today) as a
// Purchase Invoice, and polls for its payment/reconciliation status. Kept
// separate from PaymentQueueService — that owns TallyMatch's own manual
// proof-of-payment flow, this owns the ERP-sync counterpart, and the two
// meet only at the shared `status`/`payment_source` fields on Invoice.
@Injectable()
export class ErpPushService {
  constructor(
    private readonly repository: AccountsPayableRepository,
    private readonly audit: AuditLogService,
    private readonly erpConnections: ErpConnectionsService,
    private readonly sapB1Connector: SapB1ConnectorService
  ) {}

  async pushInvoice(orgId: string, invoiceId: string, userId: string | undefined): Promise<Invoice> {
    const invoice = await this.repository.getInvoiceById(orgId, invoiceId);
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.erp_push_status === "pushed") {
      throw new BadRequestException("Invoice was already pushed to the ERP");
    }

    const config = await this.erpConnections.getConfigForOrg(orgId);

    // Prefer chaining to the matched GRN's SAP B1 document if it was synced
    // from SAP B1 (has erp_doc_entry) — this gives SAP B1 the standard
    // GRN -> Invoice base-document link. Falls back to a standalone invoice
    // (no BaseEntry/BaseType/BaseLine) if the GRN was manually entered or
    // CSV-imported instead, which real SAP B1 accepts for an unlinked AP invoice.
    const [purchaseOrders, goodsReceiptNotes] = await Promise.all([
      this.repository.listPurchaseOrders(orgId),
      this.repository.listGoodsReceiptNotes(orgId),
    ]);
    const matchedPo = purchaseOrders.find((p) => p.po_number === invoice.po_number);
    const matchedGrn = goodsReceiptNotes.find((g) => g.grn_number === invoice.grn_number);

    // KNOWN LIMITATION: SAP B1 requires a CardCode (business-partner master
    // key) that TallyMatch has no vendor-master mapping for today — we only
    // store vendor_name as free text. If the matched PO/GRN was synced from
    // SAP B1 we know its real CardCode; otherwise this falls back to using
    // vendor_name as a stand-in, which will NOT match a real SAP B1
    // BusinessPartner and needs a proper vendor-mapping table before going
    // live against the real Service Layer.
    let cardCode = invoice.vendor_name ?? "UNKNOWN";
    if (matchedGrn?.erp_doc_entry != null) {
      const grnFromErp = await this.sapB1Connector
        .fetchPurchaseDeliveryNote(config, orgId, matchedGrn.erp_doc_entry)
        .catch(() => null);
      if (grnFromErp) cardCode = grnFromErp.CardCode;
    } else if (matchedPo?.erp_doc_entry != null) {
      const poFromErp = await this.sapB1Connector.fetchPurchaseOrder(config, orgId, matchedPo.erp_doc_entry).catch(() => null);
      if (poFromErp) cardCode = poFromErp.CardCode;
    }

    const lineItems = invoice.line_items ?? [];
    if (lineItems.length === 0) {
      throw new BadRequestException("Invoice has no line items to push");
    }

    try {
      const pushed = await this.sapB1Connector.pushPurchaseInvoice(config, orgId, {
        CardCode: cardCode,
        CardName: invoice.vendor_name ?? undefined,
        DocDate: invoice.invoice_date ?? new Date().toISOString().slice(0, 10),
        DocDueDate: invoice.due_date ?? invoice.invoice_date ?? new Date().toISOString().slice(0, 10),
        Comments: `Pushed by TallyMatch (invoice ${invoice.invoice_number ?? invoice.id})`,
        DocumentLines: lineItems.map((item, i) => ({
          LineNum: i,
          ItemCode: item.sku ?? item.item_sku ?? `LINE-${i}`,
          ItemDescription: item.description,
          Quantity: item.quantity ?? 1,
          UnitPrice: item.unit_price ?? item.amount,
          LineTotal: item.amount,
          ...(matchedGrn?.erp_doc_entry != null
            ? { BaseType: SAP_B1_OBJECT_TYPE.PurchaseDeliveryNote, BaseEntry: matchedGrn.erp_doc_entry, BaseLine: i }
            : {}),
        })),
      });

      const updated = await this.repository.updateInvoice(orgId, invoiceId, {
        erp_type: "sap_b1",
        erp_push_status: "pushed",
        erp_doc_entry: pushed.DocEntry,
        erp_doc_num: pushed.DocNum,
        erp_push_error: null,
        erp_pushed_at: new Date().toISOString(),
      });

      await this.audit.write({
        orgId,
        invoiceId: updated.id,
        invoiceNumber: updated.invoice_number,
        vendorName: updated.vendor_name,
        event: "ERP_PUSHED",
        status: updated.status,
        totalAmount: updated.total_amount,
        notes: `Pushed to SAP B1 by ${userId ?? "unknown user"} as DocEntry=${pushed.DocEntry} DocNum=${pushed.DocNum}`,
        metadata: { erp_doc_entry: pushed.DocEntry, erp_doc_num: pushed.DocNum },
      });

      return updated;
    } catch (err) {
      const message = err instanceof SapB1Error ? err.message : err instanceof Error ? err.message : "Unknown error";

      const updated = await this.repository.updateInvoice(orgId, invoiceId, {
        erp_push_status: "failed",
        erp_push_error: message,
      });

      await this.audit.write({
        orgId,
        invoiceId: updated.id,
        invoiceNumber: updated.invoice_number,
        vendorName: updated.vendor_name,
        event: "ERP_PUSH_FAILED",
        status: updated.status,
        totalAmount: updated.total_amount,
        notes: `Push to SAP B1 failed: ${message}`,
      });

      // Surfaced to the frontend as the actual SAP B1 error — never a
      // generic failure — so it must not be swallowed here.
      throw new BadRequestException(message);
    }
  }

  async syncPaymentStatus(orgId: string, invoiceId: string): Promise<Invoice> {
    const invoice = await this.repository.getInvoiceById(orgId, invoiceId);
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.erp_push_status !== "pushed" || invoice.erp_doc_entry == null) {
      throw new BadRequestException("Invoice has not been pushed to the ERP yet");
    }

    const config = await this.erpConnections.getConfigForOrg(orgId);
    const { invoice: erpInvoice, isPaid } = await this.sapB1Connector.fetchPurchaseInvoiceStatus(
      config,
      orgId,
      invoice.erp_doc_entry
    );

    const syncedAt = new Date().toISOString();

    if (!isPaid || invoice.status === "paid") {
      // Nothing changed (still open, or we already knew it was paid) — just
      // record that a sync happened, since the UI shows this timestamp
      // regardless of outcome.
      return this.repository.updateInvoice(orgId, invoiceId, { erp_last_synced_at: syncedAt });
    }

    const invoiceTotal = Number(invoice.total_amount) || 0;
    const paymentAmountMismatch = Math.abs(erpInvoice.PaidToDate - invoiceTotal) > AMOUNT_TOLERANCE;

    const updated = await this.repository.updateInvoice(orgId, invoiceId, {
      status: "paid",
      payment_source: "erp_sync",
      erp_last_synced_at: syncedAt,
      amount_paid: erpInvoice.PaidToDate,
      payment_amount_mismatch: paymentAmountMismatch,
    });

    await this.audit.write({
      orgId,
      invoiceId: updated.id,
      invoiceNumber: updated.invoice_number,
      vendorName: updated.vendor_name,
      event: "ERP_PAYMENT_SYNCED",
      status: "paid",
      totalAmount: updated.total_amount,
      notes: `Marked paid via SAP B1 sync (DocEntry=${invoice.erp_doc_entry}, PaidToDate=${erpInvoice.PaidToDate})`,
    });

    return updated;
  }
}
