// Pure — ties bundle-resolution.ts's field-level primitives into full
// document resolution. Unit-testable without Gemini or a DB.
import type { RichInvoiceDocument, RichPoDocument, RichGrnDocument } from "../../schemas/bundle-extraction.schema.js";
import type { Finding, InvoiceLineItem, Json } from "../../types/database.js";
import {
  resolveField,
  mapRichLineItemToFlat,
  checkLineMath,
  checkSumMatchesTotal,
  checkDuplicateItemCodes,
  crossCheckPrintedNumberAgainstText,
  normalizeId
} from "./bundle-resolution.js";

export interface ResolvedInvoice {
  vendor_name: string | null;
  vendor_ntn: string | null;
  vendor_ntn_raw: string | null;
  invoice_number: string | null;
  po_number: string | null;
  po_number_source: "printed" | "handwritten" | "stamp" | null;
  grn_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  currency: string | null;
  payment_terms: string | null;
  vendor_bank_name: string | null;
  vendor_account_number: string | null;
  vendor_iban: string | null;
  line_items: InvoiceLineItem[];
  findings: Finding[];
  extraction_metadata: Json;
}

export function resolveInvoiceDocument(doc: RichInvoiceDocument, pdfText: string): ResolvedInvoice {
  const findings: Finding[] = [];
  const push = (f: Finding | null) => {
    if (f) findings.push(f);
  };

  const vendorName = resolveField(doc.vendor_name, "vendor_name");
  push(vendorName.finding);
  const invoiceNumber = resolveField(doc.invoice_number, "invoice_number");
  push(invoiceNumber.finding);
  const invoiceDate = resolveField(doc.invoice_date, "invoice_date");
  push(invoiceDate.finding);
  const dueDate = doc.due_date ? resolveField(doc.due_date, "due_date") : { value: null, finding: null };
  push(dueDate.finding);
  const subtotal = resolveField(doc.subtotal, "subtotal");
  push(subtotal.finding);
  const taxAmount = resolveField(doc.tax_amount, "tax_amount");
  push(taxAmount.finding);
  const totalAmount = resolveField(doc.total_amount, "total_amount");
  push(totalAmount.finding);
  push(crossCheckPrintedNumberAgainstText(doc.total_amount, pdfText, "total_amount"));
  push(crossCheckPrintedNumberAgainstText(doc.subtotal, pdfText, "subtotal"));

  const poField = doc.po_number ? resolveField(doc.po_number, "po_number") : { value: null, finding: null };
  push(poField.finding);
  const grnField = doc.grn_number ? resolveField(doc.grn_number, "grn_number") : { value: null, finding: null };
  push(grnField.finding);

  const vendorNtnField = doc.vendor_ntn_raw ? resolveField(doc.vendor_ntn_raw, "vendor_ntn") : { value: null, finding: null };
  push(vendorNtnField.finding);
  const vendorNtnNormalized = normalizeId(vendorNtnField.value);
  const vendorStrnField = doc.vendor_strn_raw ? resolveField(doc.vendor_strn_raw, "vendor_strn") : { value: null, finding: null };
  const vendorStrnNormalized = normalizeId(vendorStrnField.value);

  if (!vendorNtnNormalized && !vendorStrnNormalized) {
    findings.push({
      code: "MISSING_SUPPLIER_TAX_ID",
      severity: "REVIEW",
      message: "No supplier NTN or STRN found on this invoice"
    });
  }

  if (doc.date_format_ambiguous) {
    findings.push({
      code: "DATE_ANOMALY",
      severity: "REVIEW",
      message: `Invoice date "${invoiceDate.value ?? doc.invoice_date.raw_text}" is ambiguous (could be read more than one way) — confirm DD-MM-YY vs MM-DD-YY`
    });
  }

  for (const item of doc.line_items) push(checkLineMath(item));
  push(checkSumMatchesTotal(doc.line_items, subtotal.value));
  findings.push(...checkDuplicateItemCodes(doc.line_items));

  for (const nr of doc.needs_review) {
    findings.push({ code: "LOW_CONFIDENCE", severity: "REVIEW", message: `${nr.field}: ${nr.reason}` });
  }

  return {
    vendor_name: vendorName.value,
    vendor_ntn: vendorNtnNormalized,
    vendor_ntn_raw: vendorNtnField.value,
    invoice_number: invoiceNumber.value,
    po_number: poField.value,
    po_number_source: doc.po_number?.source ?? null,
    grn_number: grnField.value,
    invoice_date: invoiceDate.value,
    due_date: dueDate.value,
    subtotal: subtotal.value,
    tax_amount: taxAmount.value,
    total_amount: totalAmount.value,
    currency: doc.currency,
    payment_terms: doc.payment_terms,
    vendor_bank_name: doc.vendor_bank_name,
    vendor_account_number: doc.vendor_account_number,
    vendor_iban: doc.vendor_iban,
    line_items: doc.line_items.map(mapRichLineItemToFlat),
    findings,
    extraction_metadata: doc as unknown as Json
  };
}

export interface ResolvedPo {
  po_number: string | null;
  vendor_name: string | null;
  total_amount: number | null;
  line_items: InvoiceLineItem[];
  findings: Finding[];
  extraction_metadata: Json;
}

export function resolvePoDocument(doc: RichPoDocument): ResolvedPo {
  const findings: Finding[] = [];
  const push = (f: Finding | null) => {
    if (f) findings.push(f);
  };

  const poNumber = resolveField(doc.po_number, "po_number");
  push(poNumber.finding);
  const vendorName = resolveField(doc.vendor_name, "vendor_name");
  push(vendorName.finding);
  const totalAmount = resolveField(doc.total_amount, "total_amount");
  push(totalAmount.finding);

  for (const nr of doc.needs_review) {
    findings.push({ code: "LOW_CONFIDENCE", severity: "REVIEW", message: `${nr.field}: ${nr.reason}` });
  }

  return {
    po_number: poNumber.value,
    vendor_name: vendorName.value,
    total_amount: totalAmount.value,
    line_items: doc.line_items.map(mapRichLineItemToFlat),
    findings,
    extraction_metadata: doc as unknown as Json
  };
}

export interface ResolvedGrn {
  grn_number: string | null;
  po_number: string | null;
  vendor_name: string | null;
  received_at: string | null;
  line_items: InvoiceLineItem[];
  findings: Finding[];
  extraction_metadata: Json;
}

export function resolveGrnDocument(doc: RichGrnDocument): ResolvedGrn {
  const findings: Finding[] = [];
  const push = (f: Finding | null) => {
    if (f) findings.push(f);
  };

  const grnNumber = doc.grn_number ? resolveField(doc.grn_number, "grn_number") : { value: null, finding: null };
  push(grnNumber.finding);
  const poNumber = doc.po_number ? resolveField(doc.po_number, "po_number") : { value: null, finding: null };
  push(poNumber.finding);
  const vendorName = doc.vendor_name ? resolveField(doc.vendor_name, "vendor_name") : { value: null, finding: null };
  push(vendorName.finding);
  const stampDate = doc.stamp_received_date ? resolveField(doc.stamp_received_date, "stamp_received_date") : { value: null, finding: null };
  push(stampDate.finding);

  if (doc.date_implausible) {
    findings.push({
      code: "DATE_ANOMALY",
      severity: "REVIEW",
      message: `Receiving stamp date "${stampDate.value ?? "unclear"}" looks implausible — confirm`
    });
  }

  // A GRN template lists every item ever ordered — only rows with an actual
  // handwritten receiving mark (a quantity or an annotation) represent a real
  // receipt. The extraction prompt already tells Gemini to exclude unmarked
  // template rows, but filter defensively here too.
  const receivedLines = doc.line_items.filter((item) => item.qty.value != null || item.annotations.length > 0);

  for (const nr of doc.needs_review) {
    findings.push({ code: "LOW_CONFIDENCE", severity: "REVIEW", message: `${nr.field}: ${nr.reason}` });
  }

  return {
    grn_number: grnNumber.value,
    po_number: poNumber.value,
    vendor_name: vendorName.value,
    received_at: stampDate.value,
    line_items: receivedLines.map(mapRichLineItemToFlat),
    findings,
    extraction_metadata: doc as unknown as Json
  };
}
