import { z } from "zod";

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
    line_items: z.array(InvoiceLineItemSchema).default([])
  })
  .strict();

export type ExtractedInvoice = z.infer<typeof InvoiceExtractionSchema>;

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
- For absent fields, return null. Never guess.
`.trim();

