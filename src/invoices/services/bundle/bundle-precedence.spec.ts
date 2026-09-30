// Manual runnable script. Run with:
// npx tsx src/invoices/services/bundle/bundle-precedence.spec.ts
import { decidePoPrecedence, decideGrnPrecedence } from "./bundle-precedence.js";
import type { PurchaseOrder, GoodsReceiptNote } from "../../types/database.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}`, detail ?? "");
  }
}

function po(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: "po-1", org_id: "org-1", po_number: "PO-1", vendor_name: "V", total_amount: 100000, currency: "PKR",
    line_items: null, source: "erp_sync", erp_type: "sap_b1", erp_doc_entry: 1, erp_doc_num: 1,
    bundle_id: null, invoice_id: null, is_superseded: false, created_at: new Date().toISOString(), ...overrides
  };
}

function grn(overrides: Partial<GoodsReceiptNote> = {}): GoodsReceiptNote {
  return {
    id: "grn-1", org_id: "org-1", grn_number: "GRN-1", po_number: "PO-1", vendor_name: "V",
    total_received_amount: 100000, line_items: null, received_at: null, source: "erp_sync", erp_type: "sap_b1",
    erp_doc_entry: 1, erp_doc_num: 1, bundle_id: null, invoice_id: null, is_superseded: false,
    created_at: new Date().toISOString(), ...overrides
  };
}

// 1. No existing PO → insert
check("1. No existing PO → insert", decidePoPrecedence(null, { po_number: "PO-1", total_amount: 100000 }).action === "insert");

// 2. Existing erp_sync PO, amounts agree → skip, no findings
{
  const d = decidePoPrecedence(po({ source: "erp_sync", total_amount: 100000 }), { po_number: "PO-1", total_amount: 100000 });
  check("2. Higher-trust PO agrees → skip, no findings", d.action === "skip" && d.findings.length === 0, d);
}

// 3. Existing manual PO, amounts DISAGREE → skip, EVIDENCE_MISMATCH
{
  const d = decidePoPrecedence(po({ source: "manual", total_amount: 100000 }), { po_number: "PO-1", total_amount: 150000 });
  check(
    "3. Higher-trust PO disagrees → skip, EVIDENCE_MISMATCH raised",
    d.action === "skip" && d.findings.length === 1 && d.findings[0].code === "EVIDENCE_MISMATCH",
    d
  );
}

// 4. Existing bundle_extracted PO (same or lower trust) → insert (refine it)
{
  const d = decidePoPrecedence(po({ source: "bundle_extracted", total_amount: 90000 }), { po_number: "PO-1", total_amount: 100000 });
  check("4. Existing bundle_extracted PO → insert (refine), not skip", d.action === "insert", d);
}

// 5. csv_import counts as higher trust than bundle_extracted
{
  const d = decidePoPrecedence(po({ source: "csv_import", total_amount: 100000 }), { po_number: "PO-1", total_amount: 500 });
  check("5. csv_import PO disagreeing → skip with EVIDENCE_MISMATCH", d.action === "skip" && d.findings.length === 1, d);
}

// 6. GRN: same rules apply
{
  const noConflict = decideGrnPrecedence(grn({ source: "erp_sync", total_received_amount: 100000 }), { grn_number: "GRN-1", total_received_amount: 100000 });
  check("6a. Higher-trust GRN agrees → skip, no findings", noConflict.action === "skip" && noConflict.findings.length === 0, noConflict);

  const conflict = decideGrnPrecedence(grn({ source: "erp_sync", total_received_amount: 100000 }), { grn_number: "GRN-1", total_received_amount: 50000 });
  check("6b. Higher-trust GRN disagrees → EVIDENCE_MISMATCH", conflict.action === "skip" && conflict.findings[0]?.code === "EVIDENCE_MISMATCH", conflict);

  const noExisting = decideGrnPrecedence(null, { grn_number: "GRN-2", total_received_amount: 1000 });
  check("6c. No existing GRN → insert", noExisting.action === "insert");
}

console.log(failures === 0 ? "\nALL BUNDLE PRECEDENCE TEST SCENARIOS PASSED! 🎉" : `\n${failures} SCENARIO(S) FAILED`);
if (failures > 0) process.exitCode = 1;
