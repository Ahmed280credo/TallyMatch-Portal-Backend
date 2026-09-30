// Pure resolution logic — no I/O, unit-testable without Gemini or a DB.
// Takes the rich per-field extraction output (vision) plus the pdf-parse
// text layer (cross-check only) and deterministically resolves it into the
// flat shapes the rest of the app (matching engine, DB columns, CSV-import
// consumers) already expects, plus a findings[] array. A low-confidence
// handwritten value is still used as the resolved value (never silently
// dropped) but always paired with a LOW_CONFIDENCE finding, so it can never
// be the sole basis for auto-approval — see mergeFindingsIntoStatus in
// bundle-assembly.service.ts.
import type {
  RichInvoiceDocument,
  RichPoDocument,
  RichGrnDocument,
  RichLineItem
} from "../../schemas/bundle-extraction.schema.js";
import type { Finding, InvoiceLineItem } from "../../types/database.js";

export const LOW_CONFIDENCE_THRESHOLD = 0.7;
const LINE_MATH_TOLERANCE = 1;
const SUM_TOTAL_TOLERANCE = 1;

// Strip spaces and dashes, uppercase — NTN/STRN comparisons happen on this,
// never on raw_text (formatting varies: "1234567-8" vs "12345678" vs
// "1234567 8" are the same id).
export function normalizeId(raw: string | null): string | null {
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]/g, "").toUpperCase();
  return normalized || null;
}

interface FieldLike<T> {
  value: T | null;
  raw_text: string | null;
  source: "printed" | "handwritten" | "stamp" | null;
  confidence: number | null;
}

export function resolveField<T>(
  field: FieldLike<T> | null | undefined,
  fieldName: string
): { value: T | null; finding: Finding | null } {
  if (!field || field.value == null) return { value: null, finding: null };

  const isLowConfidenceHandwritten =
    field.source === "handwritten" && field.confidence != null && field.confidence < LOW_CONFIDENCE_THRESHOLD;

  if (!isLowConfidenceHandwritten) return { value: field.value, finding: null };

  return {
    value: field.value,
    finding: {
      code: "LOW_CONFIDENCE",
      severity: "REVIEW",
      message: `${fieldName}: low-confidence handwritten reading "${field.raw_text ?? field.value}" (${Math.round((field.confidence ?? 0) * 100)}% confidence) — needs human confirmation`,
      line_ref: null,
      evidence: { field: fieldName, raw_text: field.raw_text, confidence: field.confidence, source: field.source }
    }
  };
}

// Only meaningful for a field the model claims came from PRINTED text —
// handwritten/stamp values have nothing to cross-check against in pdf-parse's
// text layer by definition. Skipped entirely when pdfText is empty (a pure
// scan has no text layer at all — nothing to disagree with).
export function crossCheckPrintedNumberAgainstText(
  field: FieldLike<number> | null | undefined,
  pdfText: string,
  fieldName: string
): Finding | null {
  if (!field || field.value == null || field.source !== "printed" || !pdfText.trim()) return null;

  const normalizedText = pdfText.replace(/,/g, "");
  const asInteger = String(Math.trunc(field.value));
  const asFixed2 = field.value.toFixed(2);

  const foundInText = normalizedText.includes(asFixed2) || normalizedText.includes(asInteger);
  if (foundInText) return null;

  return {
    code: "VISION_TEXT_MISMATCH",
    severity: "REVIEW",
    message: `${fieldName}: vision read ${field.value} but that number wasn't found in the PDF's own text layer — worth a second look`,
    line_ref: null,
    evidence: { field: fieldName, vision_value: field.value }
  };
}

export function mapRichLineItemToFlat(item: RichLineItem): InvoiceLineItem {
  const description = item.code_overridden
    ? item.annotations.find((a) => a.type === "override")?.raw_text ?? item.description_raw
    : item.description_raw;

  const quantity = resolveField(item.qty, "quantity").value;
  const unitPrice = resolveField(item.unit_price, "unit_price").value;
  const amount = item.net ?? (quantity != null && unitPrice != null ? quantity * unitPrice : 0);

  return {
    sku: item.vendor_code,
    item_sku: item.spar_code_handwritten,
    description,
    quantity,
    unit_price: unitPrice,
    amount
  };
}

// Recomputes qty*price against the model's own `net` for one line — server
// code checking the model's arithmetic independently, per spec, rather than
// trusting Gemini's math.
export function checkLineMath(item: RichLineItem): Finding | null {
  const qty = resolveField(item.qty, "quantity").value;
  const price = resolveField(item.unit_price, "unit_price").value;
  if (qty == null || price == null || item.net == null) return null;

  const computed = qty * price - (item.discount ?? 0) + (item.sales_tax ?? 0) + (item.excise ?? 0) + (item.adv_income_tax ?? 0);
  if (Math.abs(computed - item.net) <= LINE_MATH_TOLERANCE) return null;

  return {
    code: "LINE_MATH_MISMATCH",
    severity: "REVIEW",
    message: `"${item.description_raw}": qty × price (± discount/tax) = ${computed.toFixed(2)} but printed net is ${item.net} — recheck this line`,
    line_ref: item.description_raw,
    evidence: { qty, price, discount: item.discount, sales_tax: item.sales_tax, excise: item.excise, adv_income_tax: item.adv_income_tax, net: item.net, computed }
  };
}

export function checkSumMatchesTotal(lineItems: RichLineItem[], subtotalValue: number | null): Finding | null {
  if (subtotalValue == null || lineItems.length === 0) return null;

  const sum = lineItems.reduce((total, item) => total + (item.net ?? 0), 0);
  if (Math.abs(sum - subtotalValue) <= SUM_TOTAL_TOLERANCE) return null;

  return {
    code: "DOC_MISMATCH",
    severity: "REVIEW",
    message: `Line items sum to ${sum.toFixed(2)} but the document's subtotal reads ${subtotalValue} — recheck for a missing/extra line`,
    line_ref: null,
    evidence: { line_items_sum: sum, printed_subtotal: subtotalValue }
  };
}

// "A vendor may reuse a code for a different item" — same vendor_code with a
// DIFFERENT normalized description is the actual problem; the same code
// repeated for the same item (e.g. a split delivery line) is not.
export function checkDuplicateItemCodes(lineItems: RichLineItem[]): Finding[] {
  const byCode = new Map<string, Set<string>>();

  for (const item of lineItems) {
    if (!item.vendor_code) continue;
    const normDesc = item.description_raw.trim().toLowerCase();
    const descriptions = byCode.get(item.vendor_code) ?? new Set<string>();
    descriptions.add(normDesc);
    byCode.set(item.vendor_code, descriptions);
  }

  const findings: Finding[] = [];
  for (const [code, descriptions] of byCode) {
    if (descriptions.size <= 1) continue;
    findings.push({
      code: "DUPLICATE_ITEM_CODE",
      severity: "REVIEW",
      message: `Item code "${code}" is used for ${descriptions.size} different descriptions on this invoice (${Array.from(descriptions).join(", ")}) — confirm these are genuinely different items`,
      line_ref: code,
      evidence: { vendor_code: code, descriptions: Array.from(descriptions) }
    });
  }
  return findings;
}
