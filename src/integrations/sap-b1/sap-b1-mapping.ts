// Maps SAP B1 Service Layer document shapes onto TallyMatch's internal
// matching types (src/invoices/types/database.ts), so PurchaseOrders and
// PurchaseDeliveryNotes pulled from Service Layer can be fed straight into
// the existing runThreeWayMatch engine unchanged.
import type { InvoiceLineItem, PurchaseOrder as InternalPurchaseOrder, GoodsReceiptNote as InternalGrn } from "../../invoices/types/database.js";
import type { PurchaseOrder, PurchaseDeliveryNote } from "./sap-b1.types.js";

// DocNum is SAP B1's human/legal document number (what's printed on the
// document); DocEntry is the internal row id used for API linkage — our
// po_number/grn_number should be the former, matching what a vendor's
// invoice would actually reference.
function mapLineItems(lines: PurchaseOrder["DocumentLines"]): InvoiceLineItem[] {
  return lines.map((line) => ({
    sku: line.ItemCode,
    description: line.ItemDescription,
    quantity: line.Quantity,
    unit_price: line.UnitPrice,
    amount: line.LineTotal,
  }));
}

export function mapPurchaseOrderToInternal(po: PurchaseOrder): InternalPurchaseOrder {
  return {
    id: String(po.DocEntry),
    org_id: "",
    po_number: String(po.DocNum),
    vendor_name: po.CardName,
    total_amount: po.DocTotal,
    currency: null,
    line_items: mapLineItems(po.DocumentLines),
    created_at: po.DocDate,
  };
}

export function mapPurchaseDeliveryNoteToInternal(grn: PurchaseDeliveryNote, poByDocEntry: Map<number, PurchaseOrder>): InternalGrn {
  // GRN lines carry BaseEntry pointing back to the PO's DocEntry — resolve
  // that to the PO's DocNum so the mapped grn_number/po_number linkage uses
  // the same human-readable numbering as mapPurchaseOrderToInternal above.
  const baseEntry = grn.DocumentLines[0]?.BaseEntry;
  const basePo = baseEntry != null ? poByDocEntry.get(baseEntry) : undefined;

  return {
    id: String(grn.DocEntry),
    org_id: "",
    grn_number: String(grn.DocNum),
    po_number: basePo ? String(basePo.DocNum) : null,
    vendor_name: grn.CardName,
    total_received_amount: grn.DocTotal,
    line_items: mapLineItems(grn.DocumentLines),
    received_at: grn.DocDate,
    created_at: grn.DocDate,
  };
}
