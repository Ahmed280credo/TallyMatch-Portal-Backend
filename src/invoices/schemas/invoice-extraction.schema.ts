import { z } from "zod";
import { Type, type Schema } from "@google/genai";

export const InvoiceLineItemSchema = z.object({
  sku: z.string().trim().nullable().optional(),
  item_sku: z.string().trim().nullable().optional(),
  description: z.string().trim().min(1),
  quantity: z.number().nullable().optional(),
  unit_price: z.number().nullable().optional(),
  amount: z.number()
});

export const InvoiceExtractionSchema = z
  .object({
    vendor_name: z.string().trim().min(1),
    vendor_ntn: z.string().trim().nullable().optional(),
    invoice_number: z.string().trim().min(1),
    po_number: z.string().trim().nullable().optional(),
    grn_number: z.string().trim().nullable().optional(),
    invoice_date: z.string().trim().nullable(),
    due_date: z.string().trim().nullable().optional(),
    subtotal: z.number().nullable(),
    tax_amount: z.number().nullable(),
    total_amount: z.number(),
    currency: z.string().trim().nullable().optional(),
    payment_terms: z.string().trim().nullable().optional(),
    vendor_bank_name: z.string().trim().nullable().optional(),
    vendor_account_number: z.string().trim().nullable().optional(),
    vendor_iban: z.string().trim().nullable().optional(),
    line_items: z.array(InvoiceLineItemSchema).default([])
  })
  .strict();

export type ExtractedInvoice = z.infer<typeof InvoiceExtractionSchema>;

/**
 * Gemini `responseSchema` mirroring InvoiceExtractionSchema above, so the model's
 * output is grammar-constrained (constrained decoding) rather than merely asked
 * nicely via the prompt. Without this, Gemini has intermittently emitted a missing
 * "}" between line_items array entries — still syntactically valid JSON (objects
 * may have duplicate keys), so JSON.parse silently keeps only the last item's
 * fields and earlier line items vanish with no error. Keep this in sync with
 * InvoiceExtractionSchema by hand — there's no zod-to-json-schema dependency here.
 */
const nullableString: Schema = { type: Type.STRING, nullable: true };
const nullableNumber: Schema = { type: Type.NUMBER, nullable: true };

export const invoiceExtractionResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    vendor_name: { type: Type.STRING },
    vendor_ntn: nullableString,
    invoice_number: { type: Type.STRING },
    po_number: nullableString,
    grn_number: nullableString,
    invoice_date: nullableString,
    due_date: nullableString,
    subtotal: nullableNumber,
    tax_amount: nullableNumber,
    total_amount: { type: Type.NUMBER },
    currency: nullableString,
    payment_terms: nullableString,
    vendor_bank_name: nullableString,
    vendor_account_number: nullableString,
    vendor_iban: nullableString,
    line_items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sku: nullableString,
          item_sku: nullableString,
          description: { type: Type.STRING },
          quantity: nullableNumber,
          unit_price: nullableNumber,
          amount: { type: Type.NUMBER }
        },
        required: ["description", "amount"]
      }
    }
  },
  required: ["vendor_name", "invoice_number", "invoice_date", "subtotal", "tax_amount", "total_amount", "line_items"]
};

export const extractionPrompt = `
You are a data extraction engine for accounts payable invoices.
Return only a valid JSON object matching this schema:
{
  "vendor_name": "string",
  "vendor_ntn": "string|null",
  "invoice_number": "string",
  "po_number": "string|null",
  "grn_number": "string|null",
  "invoice_date": "string|null",
  "due_date": "string|null",
  "subtotal": "number|null",
  "tax_amount": "number|null",
  "total_amount": "number",
  "currency": "string|null",
  "payment_terms": "string|null",
  "vendor_bank_name": "string|null",
  "vendor_account_number": "string|null",
  "vendor_iban": "string|null",
  "line_items": [
    {
      "sku": "string|null",
      "item_sku": "string|null",
      "description": "string",
      "quantity": "number|null",
      "unit_price": "number|null",
      "amount": "number"
    }
  ]
}

Rules:
- Copy financial values exactly as printed. Do not recalculate totals.
- total_amount must be the final Balance Due, Total Due, Amount Due, or Total value.
- po_number must be null unless explicitly labeled PO Number, PO#, P.O., Purchase Order No, Purchase Order Number, or PO Reference.
- grn_number must be null unless explicitly labeled GRN Reference, GRN Number, GRN#, Goods Receipt Note, or Delivery Note No.
- vendor_bank_name, vendor_account_number, and vendor_iban must be null unless the invoice explicitly prints vendor/beneficiary bank payment details (e.g. "Bank Name", "Account Number", "IBAN", "Beneficiary Bank"). Never guess or infer these from context.
- For absent fields, return null. Never guess.
`.trim();

