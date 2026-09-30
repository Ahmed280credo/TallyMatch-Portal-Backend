// ============================================================================
// Bundle extraction v2 (Phase 1) — vision-first, page-aware, per-field
// {value, raw_text, source, confidence} extraction for real Pakistani FMCG
// paperwork: multi-page invoices, handwriting, stamps, bundled scans.
//
// This is a NEW, additive schema — invoice-extraction.schema.ts (the
// existing single-invoice, flat-value schema) is untouched and stays the
// live path for any org without EXTRACTION_V2 enabled.
//
// Two Gemini calls per bundle:
//   1. Classification (cheap, one call per page in parallel) — classify.
//   2. Rich extraction (one call per grouped document) — extract.
// Grouping pages into documents happens in our own code (bundle-grouping.ts),
// not inside a single giant Gemini call, so each Gemini call's schema stays
// small and the join-across-pages logic is unit-testable without Gemini.
// ============================================================================
import { z } from "zod";
import { Type, type Schema } from "@google/genai";

export const EXTRACTION_PROMPT_VERSION = "v2.0";

// ── Page classification ─────────────────────────────────────────────────────

export const PageTypeSchema = z.enum(["invoice", "cash_memo", "po", "delivery_note", "grn", "blank", "other"]);

export const PageClassificationResultSchema = z.object({
  page_type: PageTypeSchema,
  // The document/invoice/PO/GRN number visible on this page, if any — used
  // to group pages belonging to the same multi-page document. Null if this
  // page carries no identifying number (e.g. a continuation page whose items
  // wrap from the previous page).
  document_number: z.string().trim().nullable(),
  confidence: z.number().min(0).max(1)
});
export type PageClassificationResult = z.infer<typeof PageClassificationResultSchema>;

export const pageClassificationResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    page_type: { type: Type.STRING, enum: ["invoice", "cash_memo", "po", "delivery_note", "grn", "blank", "other"] },
    document_number: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER }
  },
  required: ["page_type", "confidence"]
};

export const pageClassificationPrompt = `
You are classifying ONE page from a scanned accounts-payable document bundle
(a Pakistani FMCG vendor's invoice packet — invoice, purchase order copy,
and/or delivery note/GRN sheet, in any order).

Return only a valid JSON object:
{
  "page_type": "invoice|cash_memo|po|delivery_note|grn|blank|other",
  "document_number": "string|null",
  "confidence": "number between 0 and 1"
}

Rules:
- "invoice": a vendor's tax invoice / sales invoice / bill.
- "cash_memo": a simplified cash-sale receipt (no credit terms).
- "po": a purchase order — a buyer-issued order document, not a vendor invoice.
- "delivery_note" / "grn": a goods-received / delivery confirmation sheet, often
  with handwritten received quantities, ticks, or a receiving stamp.
- "blank": no printed or handwritten content of consequence.
- "other": anything else (letterhead cover page, terms & conditions page, etc.)
- document_number: the invoice/PO/GRN/delivery-note number printed on THIS
  page's header if present, else null (e.g. a continuation page with only
  line items and no header repeated).
- If this page is clearly a continuation of the previous page (items only, no
  header, no new document number), still classify its page_type the same as
  what it's continuing (best guess from visual layout), with document_number
  null and a lower confidence.
`.trim();

// ── Rich per-field extraction primitives ────────────────────────────────────

export const FieldSourceSchema = z.enum(["printed", "handwritten", "stamp"]).nullable();

// Every key field on a document is wrapped like this rather than a bare
// scalar — never a single guess for ambiguous handwriting: return
// alternatives with confidences instead, resolved by a plausibility check in
// code (see bundle-assembly.service.ts), never by picking Gemini's first guess.
function extractedStringFieldSchema() {
  return z.object({
    value: z.string().trim().nullable(),
    raw_text: z.string().nullable(),
    source: FieldSourceSchema,
    confidence: z.number().min(0).max(1).nullable(),
    alternatives: z.array(z.object({ value: z.string(), confidence: z.number() })).optional()
  });
}

function extractedNumberFieldSchema() {
  return z.object({
    value: z.number().nullable(),
    raw_text: z.string().nullable(),
    source: FieldSourceSchema,
    confidence: z.number().min(0).max(1).nullable(),
    alternatives: z.array(z.object({ value: z.number(), confidence: z.number() })).optional()
  });
}

export type ExtractedStringField = z.infer<ReturnType<typeof extractedStringFieldSchema>>;
export type ExtractedNumberField = z.infer<ReturnType<typeof extractedNumberFieldSchema>>;

function extractedFieldGeminiSchema(valueType: typeof Type.STRING | typeof Type.NUMBER): Schema {
  return {
    type: Type.OBJECT,
    properties: {
      value: { type: valueType, nullable: true },
      raw_text: { type: Type.STRING, nullable: true },
      source: { type: Type.STRING, enum: ["printed", "handwritten", "stamp"], nullable: true },
      confidence: { type: Type.NUMBER, nullable: true },
      alternatives: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            value: { type: valueType },
            confidence: { type: Type.NUMBER }
          },
          required: ["value", "confidence"]
        }
      }
    },
    required: ["value", "raw_text", "source", "confidence"]
  };
}
const stringFieldGemini = extractedFieldGeminiSchema(Type.STRING);
const numberFieldGemini = extractedFieldGeminiSchema(Type.NUMBER);

// Handwritten mark-up on an otherwise-printed document — never overwrites the
// printed value directly; stored alongside it so a human (or the assembly
// step) can see both.
export const HandwrittenAnnotationSchema = z.object({
  type: z.enum(["override", "strike", "tick", "circle", "damage_note"]),
  field: z.string(),
  raw_text: z.string(),
  note: z.string().nullable().optional()
});

const annotationGemini: Schema = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: ["override", "strike", "tick", "circle", "damage_note"] },
    field: { type: Type.STRING },
    raw_text: { type: Type.STRING },
    note: { type: Type.STRING, nullable: true }
  },
  required: ["type", "field", "raw_text"]
};

// ── Line item (rich) ─────────────────────────────────────────────────────────

export const RichLineItemSchema = z.object({
  vendor_code: z.string().nullable(),
  description_raw: z.string(),
  qty: extractedNumberFieldSchema(),
  uom: z.string().nullable(),
  units_per_carton: z.number().nullable(),
  qty_in_pieces: z.number().nullable(),
  unit_price: extractedNumberFieldSchema(),
  price_basis: z.enum(["pre_tax", "post_tax", "pre_discount"]).nullable(),
  discount: z.number().nullable(),
  sales_tax: z.number().nullable(),
  excise: z.number().nullable(),
  fmr_allowance: z.number().nullable(),
  adv_income_tax: z.number().nullable(),
  net: z.number().nullable(),
  // Item codes staff write in the margin — treated as a suggested vendor ->
  // ERP mapping candidate (Phase 2 vendor_item_mapping), not authoritative.
  spar_code_handwritten: z.string().nullable(),
  // True when a GRN template row's printed description was overwritten by
  // hand (e.g. "guava" struck, "plum" written in) — handwritten description
  // wins when true.
  code_overridden: z.boolean().default(false),
  annotations: z.array(HandwrittenAnnotationSchema).default([])
});
export type RichLineItem = z.infer<typeof RichLineItemSchema>;

const richLineItemGemini: Schema = {
  type: Type.OBJECT,
  properties: {
    vendor_code: { type: Type.STRING, nullable: true },
    description_raw: { type: Type.STRING },
    qty: numberFieldGemini,
    uom: { type: Type.STRING, nullable: true },
    units_per_carton: { type: Type.NUMBER, nullable: true },
    qty_in_pieces: { type: Type.NUMBER, nullable: true },
    unit_price: numberFieldGemini,
    price_basis: { type: Type.STRING, enum: ["pre_tax", "post_tax", "pre_discount"], nullable: true },
    discount: { type: Type.NUMBER, nullable: true },
    sales_tax: { type: Type.NUMBER, nullable: true },
    excise: { type: Type.NUMBER, nullable: true },
    fmr_allowance: { type: Type.NUMBER, nullable: true },
    adv_income_tax: { type: Type.NUMBER, nullable: true },
    net: { type: Type.NUMBER, nullable: true },
    spar_code_handwritten: { type: Type.STRING, nullable: true },
    code_overridden: { type: Type.BOOLEAN },
    annotations: { type: Type.ARRAY, items: annotationGemini }
  },
  required: ["description_raw", "qty", "unit_price"]
};

// ── needs_review entry (illegible field — never a guess) ────────────────────

export const NeedsReviewEntrySchema = z.object({
  field: z.string(),
  reason: z.string()
});
const needsReviewGemini: Schema = {
  type: Type.OBJECT,
  properties: { field: { type: Type.STRING }, reason: { type: Type.STRING } },
  required: ["field", "reason"]
};

// ── Invoice document (rich) ──────────────────────────────────────────────────

export const RichInvoiceDocumentSchema = z.object({
  invoice_number: extractedStringFieldSchema(),
  invoice_date: extractedStringFieldSchema(),
  date_format_ambiguous: z.boolean().default(false),
  due_date: extractedStringFieldSchema().nullable(),
  vendor_name: extractedStringFieldSchema(),
  vendor_ntn_raw: extractedStringFieldSchema().nullable(),
  vendor_strn_raw: extractedStringFieldSchema().nullable(),
  buyer_ntn_raw: extractedStringFieldSchema().nullable(),
  sold_to: extractedStringFieldSchema().nullable(),
  ship_to_store: extractedStringFieldSchema().nullable(),
  // Where on the page the PO reference was found — printed header, a margin
  // note, or a stamp — null (both value and location) if absent entirely.
  po_number: extractedStringFieldSchema().nullable(),
  grn_number: extractedStringFieldSchema().nullable(),
  subtotal: extractedNumberFieldSchema(),
  tax_amount: extractedNumberFieldSchema(),
  total_amount: extractedNumberFieldSchema(),
  printed_total: z.number().nullable(),
  currency: z.string().nullable(),
  payment_terms: z.string().nullable(),
  vendor_bank_name: z.string().nullable(),
  vendor_account_number: z.string().nullable(),
  vendor_iban: z.string().nullable(),
  line_items: z.array(RichLineItemSchema).default([]),
  needs_review: z.array(NeedsReviewEntrySchema).default([])
});
export type RichInvoiceDocument = z.infer<typeof RichInvoiceDocumentSchema>;

export const richInvoiceExtractionResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    invoice_number: stringFieldGemini,
    invoice_date: stringFieldGemini,
    date_format_ambiguous: { type: Type.BOOLEAN },
    due_date: { ...stringFieldGemini, nullable: true },
    vendor_name: stringFieldGemini,
    vendor_ntn_raw: { ...stringFieldGemini, nullable: true },
    vendor_strn_raw: { ...stringFieldGemini, nullable: true },
    buyer_ntn_raw: { ...stringFieldGemini, nullable: true },
    sold_to: { ...stringFieldGemini, nullable: true },
    ship_to_store: { ...stringFieldGemini, nullable: true },
    po_number: { ...stringFieldGemini, nullable: true },
    grn_number: { ...stringFieldGemini, nullable: true },
    subtotal: numberFieldGemini,
    tax_amount: numberFieldGemini,
    total_amount: numberFieldGemini,
    printed_total: { type: Type.NUMBER, nullable: true },
    currency: { type: Type.STRING, nullable: true },
    payment_terms: { type: Type.STRING, nullable: true },
    vendor_bank_name: { type: Type.STRING, nullable: true },
    vendor_account_number: { type: Type.STRING, nullable: true },
    vendor_iban: { type: Type.STRING, nullable: true },
    line_items: { type: Type.ARRAY, items: richLineItemGemini },
    needs_review: { type: Type.ARRAY, items: needsReviewGemini }
  },
  required: ["invoice_number", "invoice_date", "vendor_name", "subtotal", "tax_amount", "total_amount", "line_items"]
};

// ── PO document (rich, bundle evidence — not the system-of-record PO) ──────

export const RichPoDocumentSchema = z.object({
  po_number: extractedStringFieldSchema(),
  vendor_name: extractedStringFieldSchema(),
  total_amount: extractedNumberFieldSchema(),
  line_items: z.array(RichLineItemSchema).default([]),
  needs_review: z.array(NeedsReviewEntrySchema).default([])
});
export type RichPoDocument = z.infer<typeof RichPoDocumentSchema>;

export const richPoExtractionResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    po_number: stringFieldGemini,
    vendor_name: stringFieldGemini,
    total_amount: numberFieldGemini,
    line_items: { type: Type.ARRAY, items: richLineItemGemini },
    needs_review: { type: Type.ARRAY, items: needsReviewGemini }
  },
  required: ["po_number", "vendor_name", "total_amount", "line_items"]
};

// ── GRN / delivery-note document (rich) ──────────────────────────────────────

export const RichGrnDocumentSchema = z.object({
  // Often blank on the physical sheet — a template lists every item, only
  // rows with a handwritten receiving qty count as actually received.
  grn_number: extractedStringFieldSchema().nullable(),
  po_number: extractedStringFieldSchema().nullable(),
  vendor_name: extractedStringFieldSchema().nullable(),
  // From the receiving stamp, if present.
  stamp_received_date: extractedStringFieldSchema().nullable(),
  stamp_signer: z.string().nullable(),
  date_implausible: z.boolean().default(false),
  line_items: z.array(RichLineItemSchema).default([]),
  needs_review: z.array(NeedsReviewEntrySchema).default([])
});
export type RichGrnDocument = z.infer<typeof RichGrnDocumentSchema>;

export const richGrnExtractionResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    grn_number: { ...stringFieldGemini, nullable: true },
    po_number: { ...stringFieldGemini, nullable: true },
    vendor_name: { ...stringFieldGemini, nullable: true },
    stamp_received_date: { ...stringFieldGemini, nullable: true },
    stamp_signer: { type: Type.STRING, nullable: true },
    date_implausible: { type: Type.BOOLEAN },
    line_items: { type: Type.ARRAY, items: richLineItemGemini },
    needs_review: { type: Type.ARRAY, items: needsReviewGemini }
  },
  required: ["line_items"]
};

// ── Prompts ──────────────────────────────────────────────────────────────────

const SHARED_RULES = `
Rules:
- Copy financial values exactly as printed. Do not recalculate totals.
- Every key field is an object {value, raw_text, source, confidence} — never
  a bare value. source is "printed", "handwritten", or "stamp". confidence is
  0-1. If the field is genuinely absent, return value: null but still return
  the wrapper object.
- A handwritten quantity on a PO copy is the RECEIVED quantity — it is
  evidence for a GRN, never a correction to the PO's ordered quantity.
  Example: PO qty 30 struck out, 29 written in beside it => ordered 30,
  received 29. Record this as a strike+override annotation on that line, and
  qty.value = 29 with qty.source = "handwritten".
- Ambiguous handwriting (e.g. "1,5" that could be 1.5 or 15, or an unclear
  digit): return your best value AND alternatives: [{value, confidence}, ...]
  for every plausible reading. Never silently pick one with no alternatives
  listed unless you are certain (confidence >= 0.95).
- po_number must be null unless explicitly labeled PO Number, PO#, P.O.,
  Purchase Order No, Purchase Order Number, or PO Reference — check the
  header, margins, and top of the page; record where it was found via source.
- grn_number must be null unless explicitly labeled GRN Reference, GRN
  Number, GRN#, Goods Receipt Note, or Delivery Note No.
- vendor_bank_name, vendor_account_number, and vendor_iban must be null
  unless the document explicitly prints vendor/beneficiary bank payment
  details. Never guess or infer these from context.
- Illegible or absent fields: value: null and add a needs_review entry
  {field, reason}. Never guess.
- Dates are DD-MM-YY unless explicitly stated otherwise in the document. If
  both DD-MM and MM-DD are plausible readings, set date_format_ambiguous (or
  date_implausible for a stamp date) to true.
`.trim();

export const richInvoiceExtractionPrompt = `
You are a data extraction engine for a single Pakistani FMCG vendor invoice
(or cash memo) document — possibly spanning multiple pages, already isolated
from the rest of its bundle (PO copy / delivery note are extracted
separately). If line items continue from a previous page (e.g. a line's
description or quantity only appears at the top of this page), that has
already been joined into what you're given — extract from the full document
as one continuous set of line items.

Return only a valid JSON object matching the RichInvoiceDocument schema.

${SHARED_RULES}
- total_amount must be the final Balance Due, Total Due, Amount Due, or Total
  printed value. printed_total is that same number as a plain number (no
  wrapper) for a quick cross-check against subtotal+tax computed elsewhere.
- line_math_ok / sum_matches_total are NOT computed by you — server-side code
  recomputes qty*price and totals independently. Do not attempt this
  yourself; focus purely on faithful extraction.
`.trim();

export const richPoExtractionPrompt = `
You are extracting a Purchase Order document — a buyer-issued order, found as
part of a vendor's invoice bundle. This is EVIDENCE from paper, not the
system-of-record PO. A PO may have line items on one page and only totals on
a later page — join accordingly.

Return only a valid JSON object matching the RichPoDocument schema.

${SHARED_RULES}
`.trim();

export const richGrnExtractionPrompt = `
You are extracting a Goods Receipt Note / delivery note document from a
vendor's invoice bundle. These are often a printed template listing every
item ever ordered — only rows with an actual handwritten receiving mark
(a quantity, a tick, a circle) represent a real receipt; ignore template rows
with no handwritten mark at all (do not include them in line_items).
If a row's printed description was overwritten by hand (e.g. "guava" struck,
"plum" written in), use the handwritten description as the value and set
code_overridden: true on that line.
Look for a receiving stamp: extract its date (stamp_received_date) and any
signer name visible (stamp_signer). grn_number is very often blank on these
sheets — that's normal, return null rather than guessing.

Return only a valid JSON object matching the RichGrnDocument schema.

${SHARED_RULES}
`.trim();
