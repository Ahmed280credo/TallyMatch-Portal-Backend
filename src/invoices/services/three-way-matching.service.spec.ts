import { runThreeWayMatch } from "./three-way-matching.service.js";
import type { ExtractedInvoice } from "../schemas/invoice-extraction.schema.js";
import type { GoodsReceiptNote, PurchaseOrder } from "../types/database.js";

// Manual runnable script — mirrors the convention used by csv-bulk-import.service.spec.ts
// in this repo (no Jest configured; run via `node dist/invoices/services/three-way-matching.service.spec.js`
// after `npm run build`, or with ts-node/tsx directly).

function invoice(overrides: Partial<ExtractedInvoice> = {}): ExtractedInvoice {
  return {
    vendor_name: "Acme Traders",
    vendor_ntn: null,
    invoice_number: "INV-1",
    po_number: "PO-1001",
    grn_number: null,
    invoice_date: "2026-08-15",
    due_date: null,
    subtotal: 500000,
    tax_amount: 28000,
    total_amount: 528000,
    currency: "PKR",
    payment_terms: null,
    vendor_bank_name: null,
    vendor_account_number: null,
    vendor_iban: null,
    line_items: [
      { description: "Steel Rods 12mm", quantity: 100, unit_price: 4000, amount: 400000 },
      { description: "Steel Plates", quantity: 32, unit_price: 3500, amount: 112000 },
    ],
    ...overrides,
  };
}

function po(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: "po-1",
    org_id: "org-1",
    po_number: "PO-1001",
    vendor_name: "Acme Traders",
    total_amount: 528000,
    currency: "PKR",
    line_items: [
      { description: "Steel Rods 12mm", unit_price: 4000, amount: 400000 },
      { description: "Steel Plates", unit_price: 3500, amount: 112000 },
    ],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function grn(overrides: Partial<GoodsReceiptNote> = {}): GoodsReceiptNote {
  return {
    id: "grn-1",
    org_id: "org-1",
    grn_number: "GRN-5001",
    po_number: "PO-1001",
    vendor_name: "Acme Traders",
    total_received_amount: 528000,
    line_items: [
      { description: "Steel Rods 12mm", quantity: 100, amount: 0 },
      { description: "Steel Plates", quantity: 32, amount: 0 },
    ],
    received_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}`, detail ?? "");
  }
}

async function runTests() {
  // 1. Clean match — everything agrees, all documents found
  {
    const result = runThreeWayMatch(invoice(), [po()], [grn()]);
    check("1. Clean match approves", result.status === "approved", result);
  }

  // 2. No PO reference on invoice at all
  {
    const result = runThreeWayMatch(invoice({ po_number: null }), [po()], [grn()]);
    check("2. No PO reference → pending", result.status === "pending", result);
  }

  // 3. PO referenced but not found in system
  {
    const result = runThreeWayMatch(invoice({ po_number: "PO-9999" }), [po()], [grn()]);
    check("3. PO not found → pending", result.status === "pending", result);
  }

  // 4. PO found but no GRN linked
  {
    const result = runThreeWayMatch(invoice(), [po()], []);
    check("4. No GRN for PO → pending", result.status === "pending", result);
  }

  // 5. PO has no total_amount recorded
  {
    const result = runThreeWayMatch(invoice(), [po({ total_amount: null })], [grn()]);
    check("5. PO total_amount null → pending", result.status === "pending", result);
  }

  // 6. Invoice total doesn't match PO total (PO vs Invoice amount check — unchanged)
  {
    const result = runThreeWayMatch(invoice({ total_amount: 999999 }), [po()], [grn()]);
    check(
      "6. Invoice total ≠ PO total → mismatch",
      result.status === "mismatch" && result.mismatch_reasons.some((r) => r.includes("PO PKR")),
      result
    );
  }

  // 7. Over-billing: invoice qty > GRN received qty
  {
    const result = runThreeWayMatch(
      invoice(),
      [po()],
      [grn({ line_items: [{ description: "Steel Rods 12mm", quantity: 50, amount: 0 }, { description: "Steel Plates", quantity: 32, amount: 0 }] })]
    );
    check(
      "7. Over-billing (invQty > grnQty) → mismatch, labeled over-billing",
      result.status === "mismatch" && result.mismatch_reasons.some((r) => r.includes("over-billing")),
      result
    );
  }

  // 8. NEW: Under-billing — invoice qty < GRN received qty must now be flagged
  //    (previously silently passed; this is the required bidirectional fix)
  {
    const result = runThreeWayMatch(
      invoice(),
      [po()],
      [grn({ line_items: [{ description: "Steel Rods 12mm", quantity: 150, amount: 0 }, { description: "Steel Plates", quantity: 32, amount: 0 }] })]
    );
    check(
      "8. Under-billing (invQty < grnQty) → mismatch, labeled under-billing",
      result.status === "mismatch" && result.mismatch_reasons.some((r) => r.includes("under-billing")),
      result
    );
  }

  // 9. Unit price mismatch (PO vs Invoice — the only remaining price check)
  {
    const result = runThreeWayMatch(
      invoice(),
      [po({ line_items: [{ description: "Steel Rods 12mm", unit_price: 5000, amount: 500000 }, { description: "Steel Plates", unit_price: 3500, amount: 112000 }] })],
      [grn()]
    );
    check(
      "9. Unit price mismatch (PO vs Invoice) → mismatch",
      result.status === "mismatch" && result.mismatch_reasons.some((r) => r.includes("Unit price mismatch")),
      result
    );
  }

  // 10. REMOVED CHECK REGRESSION GUARD: GRN with no total_received_amount must no
  //     longer affect the outcome at all — grn_amount_match is gone, GRN only
  //     participates in the quantity check now.
  {
    const result = runThreeWayMatch(invoice(), [po()], [grn({ total_received_amount: null })]);
    check(
      "10. GRN missing total_received_amount no longer affects status (still approved)",
      result.status === "approved",
      result
    );
    check(
      "10b. 'grn_amount_match' key is absent from checks output",
      !("grn_amount_match" in result.match_result.checks),
      result.match_result.checks
    );
  }

  // 11. GRN with a total_received_amount that disagrees with the invoice total
  //     must NOT be flagged — GRN amount is no longer a matching field at all.
  {
    const result = runThreeWayMatch(invoice(), [po()], [grn({ total_received_amount: 1 })]);
    check(
      "11. GRN total_received_amount disagreeing with invoice is ignored (still approved)",
      result.status === "approved",
      result
    );
  }

  // 12. Multiple GRNs against the same PO (partial/staggered deliveries) —
  //     quantities must be summed across all of them, not just the first found.
  {
    const result = runThreeWayMatch(
      invoice(),
      [po()],
      [
        grn({ id: "grn-1", grn_number: "GRN-5001", line_items: [{ description: "Steel Rods 12mm", quantity: 60, amount: 0 }] }),
        grn({ id: "grn-2", grn_number: "GRN-5002", line_items: [{ description: "Steel Rods 12mm", quantity: 40, amount: 0 }, { description: "Steel Plates", quantity: 32, amount: 0 }] }),
      ]
    );
    check(
      "12. Multiple GRNs for one PO are all found",
      result.match_result.checks.grn_found_for_po.pass &&
        (result.match_result.checks.grn_found_for_po.detail ?? "").includes("2 GRNs"),
      result
    );
    check(
      "12b. Quantities summed across GRNs (60+40=100) → approved, no mismatch",
      result.status === "approved",
      result
    );
  }

  // 13. Multiple GRNs whose summed quantity still doesn't cover the invoice
  //     must be flagged — proves the sum, not just presence, is checked.
  {
    const result = runThreeWayMatch(
      invoice(),
      [po()],
      [
        grn({ id: "grn-1", grn_number: "GRN-5001", line_items: [{ description: "Steel Rods 12mm", quantity: 30, amount: 0 }, { description: "Steel Plates", quantity: 32, amount: 0 }] }),
        grn({ id: "grn-2", grn_number: "GRN-5002", line_items: [{ description: "Steel Rods 12mm", quantity: 20, amount: 0 }] }),
      ]
    );
    check(
      "13. Summed GRN qty (30+20=50) still short of invoiced 100 → mismatch, over-billing",
      result.status === "mismatch" && result.mismatch_reasons.some((r) => r.includes("over-billing")),
      result
    );
  }

  console.log(failures === 0 ? "\nALL THREE-WAY MATCH TEST SCENARIOS PASSED! 🎉" : `\n${failures} SCENARIO(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
