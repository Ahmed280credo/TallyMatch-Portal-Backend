import { Injectable } from "@nestjs/common";
import type { ExtractedInvoice } from "../schemas/invoice-extraction.schema.js";
import type { GoodsReceiptNote, InvoiceLineItem, PurchaseOrder } from "../types/database.js";
import { AccountsPayableRepository } from "./accounts-payable.repository.js";

export interface MatchCheck {
  pass: boolean;
  detail?: string;
}

export interface MatchChecks {
  po_reference_on_invoice: MatchCheck;
  po_found_in_system: MatchCheck;
  grn_found_for_po: MatchCheck;
  total_amount_match: MatchCheck;
  line_item_unit_prices: MatchCheck;
  line_item_quantities: MatchCheck;
}

export interface MatchResult {
  status: "approved" | "mismatch" | "pending";
  mismatch_reasons: string[];
  pending_reasons: string[];
  match_result: {
    checks: MatchChecks;
    checked_at: string;
  };
}

function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function findLineItem(
  invoiceItem: InvoiceLineItem,
  items: InvoiceLineItem[]
): InvoiceLineItem | undefined {
  const invSku = (invoiceItem.sku ?? invoiceItem.item_sku)?.trim().toLowerCase();
  if (invSku) {
    const bySku = items.find((d) => {
      const dSku = (d.sku ?? d.item_sku)?.trim().toLowerCase();
      return dSku === invSku;
    });
    if (bySku) return bySku;
  }
  const invDesc = normalizeKey(invoiceItem.description);
  return items.find((d) => normalizeKey(d.description) === invDesc);
}

// A single PO is commonly received across multiple GRNs (partial/staggered
// deliveries). Combine every GRN linked to the PO into one line-item list,
// summing received quantities per item, so matching reflects total receipts
// instead of whichever single GRN happened to be found first.
function combineGrnLineItems(grns: GoodsReceiptNote[]): InvoiceLineItem[] {
  const combined: InvoiceLineItem[] = [];

  for (const g of grns) {
    for (const item of g.line_items ?? []) {
      const existing = findLineItem(item, combined);
      if (existing) {
        existing.quantity = Number(existing.quantity ?? 0) + Number(item.quantity ?? 0);
      } else {
        combined.push({ ...item, quantity: item.quantity == null ? null : Number(item.quantity) });
      }
    }
  }

  return combined;
}

export function runThreeWayMatch(
  invoice: ExtractedInvoice,
  purchaseOrders: PurchaseOrder[],
  goodsReceiptNotes: GoodsReceiptNote[]
): MatchResult {
  // pending = PO/GRN not found; mismatch = found but amounts/qty wrong
  const pendingReasons: string[] = [];
  const mismatchReasons: string[] = [];

  const checks: MatchChecks = {
    po_reference_on_invoice: { pass: false },
    po_found_in_system: { pass: false },
    grn_found_for_po: { pass: false },
    total_amount_match: { pass: false },
    line_item_unit_prices: { pass: true },
    line_item_quantities: { pass: true },
  };

  // ── 1. PO reference present on invoice ──────────────────────────────────
  const invoicePoNumber = invoice.po_number?.trim() ?? "";
  if (!invoicePoNumber) {
    pendingReasons.push("No PO reference found on invoice");
    checks.po_reference_on_invoice = { pass: false, detail: "Invoice has no PO number" };
  } else {
    checks.po_reference_on_invoice = { pass: true, detail: invoicePoNumber };
  }

  // ── 2. PO exists in the system ──────────────────────────────────────────
  // Case-insensitive trim comparison — Gemini may extract different casing
  const po = invoicePoNumber
    ? purchaseOrders.find(
        (p) => p.po_number.trim().toLowerCase() === invoicePoNumber.toLowerCase()
      )
    : undefined;

  if (!po) {
    if (invoicePoNumber) {
      pendingReasons.push(`PO not found in system: ${invoicePoNumber}`);
      checks.po_found_in_system = { pass: false, detail: `${invoicePoNumber} not in purchase_orders` };
    } else {
      checks.po_found_in_system = { pass: false, detail: "Skipped — no PO number on invoice" };
    }
  } else {
    checks.po_found_in_system = { pass: true, detail: `Found PO ${po.po_number}` };
  }

  // ── 3. GRN(s) exist linked to that PO — a PO can be received across ────────
  //      multiple GRNs (partial/staggered deliveries), so collect all of them.
  const grns = po ? goodsReceiptNotes.filter((g) => g.po_number === po.po_number) : [];

  if (grns.length === 0) {
    if (po) {
      pendingReasons.push(`No GRN found for ${po.po_number} — goods not confirmed received`);
      checks.grn_found_for_po = { pass: false, detail: `No GRN linked to ${po.po_number}` };
    } else {
      checks.grn_found_for_po = { pass: false, detail: "Skipped — PO not found" };
    }
  } else {
    checks.grn_found_for_po = {
      pass: true,
      detail:
        grns.length === 1
          ? `Found GRN ${grns[0].grn_number}`
          : `Found ${grns.length} GRNs (${grns.map((g) => g.grn_number).join(", ")})`,
    };
  }

  // ── Checks 4-6 only run when BOTH PO and at least one GRN are found ────────
  if (po && grns.length > 0) {
    // ── 4. Total amount match (≤1 PKR tolerance for floating point) ──────────
    // PO amounts are recorded pre-tax, so compare against the invoice's pre-tax
    // subtotal — not its tax-inclusive total_amount — or every invoice with tax
    // would mismatch by exactly the tax amount. Fall back to total_amount minus
    // tax_amount, then to total_amount itself, if subtotal wasn't extracted.
    const invoiceNetAmount =
      invoice.subtotal != null
        ? invoice.subtotal
        : invoice.tax_amount != null
          ? invoice.total_amount - invoice.tax_amount
          : invoice.total_amount;

    // Supabase returns numeric columns as strings at runtime — coerce both sides
    const poTotal = po.total_amount == null ? null : Number(po.total_amount);
    if (poTotal == null || isNaN(poTotal)) {
      // A PO with no recorded amount can't confirm the invoiced value either —
      // same treatment as a GRN with no amount below: pending (needs review),
      // not a silent pass.
      pendingReasons.push(
        `PO ${po.po_number} has no total_amount recorded — cannot confirm invoiced value`
      );
      checks.total_amount_match = {
        pass: false,
        detail: `PO ${po.po_number} has no total_amount recorded`,
      };
    } else if (Math.abs(invoiceNetAmount - poTotal) > 1) {
      mismatchReasons.push(
        `Amount mismatch: Invoice subtotal PKR ${invoiceNetAmount} vs PO PKR ${poTotal}`
      );
      checks.total_amount_match = {
        pass: false,
        detail: `Invoice subtotal ${invoiceNetAmount} ≠ PO ${poTotal}`,
      };
    } else {
      checks.total_amount_match = { pass: true, detail: `Both PKR ${invoiceNetAmount}` };
    }

    // ── 5. Unit price per line item exact match (invoice vs PO) ────────────
    // GRN carries no pricing — it only confirms physical receipt — so it never
    // participates in an amount/price comparison. Amount checks are PO vs
    // Invoice only (total_amount_match above, unit prices below).
    if ((po.line_items?.length ?? 0) > 0 && invoice.line_items.length > 0) {
      const unitPriceFailures: string[] = [];

      for (const invItem of invoice.line_items) {
        const poItem = findLineItem(invItem, po.line_items!);
        if (!poItem) continue;
        if (invItem.unit_price == null || poItem.unit_price == null) continue;

        // Supabase returns numeric as string at runtime — coerce both sides
        const invPrice = Number(invItem.unit_price);
        const poPrice = Number(poItem.unit_price);
        if (Math.abs(invPrice - poPrice) > 1) {
          unitPriceFailures.push(
            `"${invItem.description}": Invoice price ${invPrice} ≠ PO price ${poPrice}`
          );
        }
      }

      if (unitPriceFailures.length > 0) {
        for (const f of unitPriceFailures) mismatchReasons.push(`Unit price mismatch — ${f}`);
        checks.line_item_unit_prices = { pass: false, detail: unitPriceFailures.join("; ") };
      } else {
        checks.line_item_unit_prices = { pass: true, detail: "All unit prices verified" };
      }
    }

    // ── 6. Quantity: invoice qty must equal total GRN qty received across all ──
    //      GRNs linked to this PO (either direction)
    const grnLineItems = combineGrnLineItems(grns);
    if (grnLineItems.length > 0 && invoice.line_items.length > 0) {
      const qtyFailures: string[] = [];

      for (const invItem of invoice.line_items) {
        const grnItem = findLineItem(invItem, grnLineItems);
        if (!grnItem) continue;

        // Skip if either side has no quantity recorded — can't compare
        if (invItem.quantity == null || grnItem.quantity == null) continue;

        // Supabase returns numeric as string at runtime — coerce both sides
        const invQty = Number(invItem.quantity);
        const grnQty = Number(grnItem.quantity);

        if (invQty > grnQty) {
          qtyFailures.push(
            `"${invItem.description}": Invoiced ${invQty} but only ${grnQty} received per GRN (over-billing)`
          );
        } else if (invQty < grnQty) {
          qtyFailures.push(
            `"${invItem.description}": Invoiced ${invQty} but ${grnQty} received per GRN (under-billing — invoice may be incomplete)`
          );
        }
      }

      if (qtyFailures.length > 0) {
        for (const f of qtyFailures) mismatchReasons.push(`Quantity mismatch: ${f}`);
        checks.line_item_quantities = { pass: false, detail: qtyFailures.join("; ") };
      } else {
        checks.line_item_quantities = { pass: true, detail: "All quantities within GRN" };
      }
    }
  } else {
    checks.total_amount_match = { pass: false, detail: "Skipped — PO or GRN not found" };
  }

  let status: "approved" | "mismatch" | "pending";
  if (mismatchReasons.length > 0) {
    status = "mismatch";
  } else if (pendingReasons.length > 0) {
    status = "pending";
  } else {
    status = "approved";
  }

  return {
    status,
    mismatch_reasons: mismatchReasons,
    pending_reasons: pendingReasons,
    match_result: {
      checks,
      checked_at: new Date().toISOString(),
    },
  };
}

@Injectable()
export class ThreeWayMatchingService {
  constructor(private readonly repository: AccountsPayableRepository) {}

  async matchInvoice(orgId: string, invoice: ExtractedInvoice): Promise<MatchResult> {
    const [purchaseOrders, goodsReceiptNotes] = await Promise.all([
      this.repository.listPurchaseOrders(orgId),
      this.repository.listGoodsReceiptNotes(orgId),
    ]);

    console.log(`[3-WAY MATCH] invoice PO="${invoice.po_number}" total=${invoice.total_amount}`);
    console.log(`[3-WAY MATCH] DB POs: ${purchaseOrders.map(p => `"${p.po_number}" total=${p.total_amount}(${typeof p.total_amount})`).join(", ") || "none"}`);
    console.log(`[3-WAY MATCH] DB GRNs: ${goodsReceiptNotes.map(g => `"${g.grn_number}" po="${g.po_number}"`).join(", ") || "none"}`);

    const result = runThreeWayMatch(invoice, purchaseOrders, goodsReceiptNotes);
    console.log(`[3-WAY MATCH] result: ${result.status} | mismatch: [${result.mismatch_reasons.join("; ")}] | pending: [${result.pending_reasons.join("; ")}]`);
    return result;
  }
}
