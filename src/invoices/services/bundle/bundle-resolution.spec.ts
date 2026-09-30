// Manual runnable script. Run with:
// npx tsx src/invoices/services/bundle/bundle-resolution.spec.ts
import { normalizeId, resolveField, crossCheckPrintedNumberAgainstText, checkLineMath, checkSumMatchesTotal, checkDuplicateItemCodes } from "./bundle-resolution.js";
import { resolveInvoiceDocument, resolveGrnDocument } from "./bundle-document-resolvers.js";
import type { RichInvoiceDocument, RichGrnDocument, RichLineItem } from "../../schemas/bundle-extraction.schema.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}`, detail ?? "");
  }
}

function field<T>(value: T | null, source: "printed" | "handwritten" | "stamp" | null = "printed", confidence: number | null = 0.95, raw_text: string | null = null) {
  return { value, raw_text: raw_text ?? (value == null ? null : String(value)), source, confidence };
}

function line(overrides: Partial<RichLineItem> = {}): RichLineItem {
  return {
    vendor_code: "FED-003219",
    description_raw: "Cooking Oil 5L",
    qty: field(100),
    uom: "carton",
    units_per_carton: null,
    qty_in_pieces: null,
    unit_price: field(2450),
    price_basis: "pre_tax",
    discount: 0,
    sales_tax: 0,
    excise: 0,
    fmr_allowance: 0,
    adv_income_tax: 0,
    net: 245000,
    spar_code_handwritten: null,
    code_overridden: false,
    annotations: [],
    ...overrides
  };
}

// 1. normalizeId strips spaces/dashes and uppercases
check("1. normalizeId strips formatting", normalizeId("1234567-8") === "12345678" && normalizeId("1234 567 8") === "12345678");
check("1b. normalizeId of null is null", normalizeId(null) === null);

// 2. resolveField: high-confidence printed → no finding
{
  const r = resolveField(field("Acme Traders", "printed", 0.99), "vendor_name");
  check("2. High-confidence printed field → no finding", r.value === "Acme Traders" && r.finding === null, r);
}

// 3. resolveField: low-confidence handwritten → value kept, LOW_CONFIDENCE finding raised
{
  const r = resolveField(field(29, "handwritten", 0.4, "29?"), "qty");
  check(
    "3. Low-confidence handwritten value still used, but flags LOW_CONFIDENCE",
    r.value === 29 && r.finding?.code === "LOW_CONFIDENCE" && r.finding?.severity === "REVIEW",
    r
  );
}

// 4. resolveField: high-confidence handwritten → no finding (confidence alone isn't the trigger, low confidence is)
{
  const r = resolveField(field(29, "handwritten", 0.92), "qty");
  check("4. High-confidence handwritten → no finding", r.finding === null, r);
}

// 5. crossCheckPrintedNumberAgainstText: number present in text → no finding
{
  const f = crossCheckPrintedNumberAgainstText(field(528000, "printed"), "Total Due: 528,000.00 PKR", "total_amount");
  check("5. Printed number found in text layer → no finding", f === null, f);
}

// 6. crossCheckPrintedNumberAgainstText: number NOT in text → VISION_TEXT_MISMATCH
{
  const f = crossCheckPrintedNumberAgainstText(field(528000, "printed"), "Total Due: 499,000.00 PKR", "total_amount");
  check("6. Printed number missing from text layer → VISION_TEXT_MISMATCH", f?.code === "VISION_TEXT_MISMATCH", f);
}

// 7. crossCheckPrintedNumberAgainstText: empty text layer (pure scan) → skipped, no finding
{
  const f = crossCheckPrintedNumberAgainstText(field(528000, "printed"), "", "total_amount");
  check("7. Empty text layer (scan) → cross-check skipped entirely", f === null, f);
}

// 8. crossCheckPrintedNumberAgainstText: handwritten source → skipped (nothing to cross-check)
{
  const f = crossCheckPrintedNumberAgainstText(field(528000, "handwritten"), "totally different text", "total_amount");
  check("8. Handwritten-source field → cross-check skipped", f === null, f);
}

// 9. checkLineMath: math checks out → no finding
{
  const f = checkLineMath(line({ qty: field(100), unit_price: field(2450), net: 245000 }));
  check("9. Line math correct → no finding", f === null, f);
}

// 10. checkLineMath: math doesn't check out → LINE_MATH_MISMATCH
{
  const f = checkLineMath(line({ qty: field(100), unit_price: field(2450), net: 999999 }));
  check("10. Line math wrong → LINE_MATH_MISMATCH", f?.code === "LINE_MATH_MISMATCH", f);
}

// 11. checkSumMatchesTotal
{
  const items = [line({ net: 100000 }), line({ net: 50000 })];
  check("11a. Sum matches subtotal → no finding", checkSumMatchesTotal(items, 150000) === null);
  check("11b. Sum doesn't match subtotal → DOC_MISMATCH", checkSumMatchesTotal(items, 200000)?.code === "DOC_MISMATCH");
}

// 12. checkDuplicateItemCodes: same code, different description → flagged
{
  const items = [
    line({ vendor_code: "FED-003219", description_raw: "Cooking Oil 5L" }),
    line({ vendor_code: "FED-003219", description_raw: "Cooking Oil 1L" })
  ];
  const findings = checkDuplicateItemCodes(items);
  check("12. Same code, different description → DUPLICATE_ITEM_CODE", findings.length === 1 && findings[0].code === "DUPLICATE_ITEM_CODE", findings);
}

// 13. checkDuplicateItemCodes: same code, same description (split line) → NOT flagged
{
  const items = [
    line({ vendor_code: "FED-003219", description_raw: "Cooking Oil 5L" }),
    line({ vendor_code: "FED-003219", description_raw: "cooking oil 5l" }) // same, just different case
  ];
  const findings = checkDuplicateItemCodes(items);
  check("13. Same code, same (normalized) description → not flagged", findings.length === 0, findings);
}

// 14. resolveInvoiceDocument: full pass, no supplier tax ID → MISSING_SUPPLIER_TAX_ID
{
  const doc: RichInvoiceDocument = {
    invoice_number: field("INV-1"),
    invoice_date: field("15-09-26"),
    date_format_ambiguous: false,
    due_date: null,
    vendor_name: field("Sea Prince Foods"),
    vendor_ntn_raw: null,
    vendor_strn_raw: null,
    buyer_ntn_raw: null,
    sold_to: null,
    ship_to_store: null,
    po_number: null,
    grn_number: null,
    subtotal: field(100000),
    tax_amount: field(18000),
    total_amount: field(118000),
    printed_total: 118000,
    currency: "PKR",
    payment_terms: null,
    vendor_bank_name: null,
    vendor_account_number: null,
    vendor_iban: null,
    line_items: [line({ net: 100000 })],
    needs_review: []
  };
  const resolved = resolveInvoiceDocument(doc, "Total Due: 118,000");
  check(
    "14. No vendor NTN/STRN → MISSING_SUPPLIER_TAX_ID",
    resolved.findings.some((f) => f.code === "MISSING_SUPPLIER_TAX_ID"),
    resolved.findings
  );
}

// 15. resolveGrnDocument: template rows with no handwritten mark are excluded
{
  const doc: RichGrnDocument = {
    grn_number: null,
    po_number: field("PO-1"),
    vendor_name: field("Nestle"),
    stamp_received_date: field("2026-09-16", "stamp"),
    stamp_signer: "M. Ali",
    date_implausible: false,
    line_items: [
      line({ description_raw: "Received item", qty: field(29, "handwritten") }),
      line({ description_raw: "Template item, never received", qty: field(null, null, null), annotations: [] })
    ],
    needs_review: []
  };
  const resolved = resolveGrnDocument(doc);
  check(
    "15. Unmarked template row excluded, marked row kept",
    resolved.line_items.length === 1 && resolved.line_items[0].description === "Received item",
    resolved.line_items
  );
}

console.log(failures === 0 ? "\nALL BUNDLE RESOLUTION TEST SCENARIOS PASSED! 🎉" : `\n${failures} SCENARIO(S) FAILED`);
if (failures > 0) process.exitCode = 1;
