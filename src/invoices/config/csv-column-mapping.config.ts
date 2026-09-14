export const REQUIRED_INVOICE_FIELDS = [
  "invoice_number",
  "vendor_name",
  "amount",
  "due_date"
] as const;

export type RequiredInvoiceField = typeof REQUIRED_INVOICE_FIELDS[number];

export const ALL_INVOICE_FIELDS = [
  "invoice_number",
  "vendor_name",
  "vendor_tax_id",
  "invoice_date",
  "due_date",
  "amount",
  "currency",
  "po_number",
  "grn_number",
  "line_items_description",
  "payment_terms",
  "vendor_bank_name",
  "vendor_account_number",
  "vendor_iban"
] as const;

export type TargetInvoiceField = typeof ALL_INVOICE_FIELDS[number];

export interface FieldDefinition {
  field: TargetInvoiceField;
  label: string;
  required: boolean;
  description: string;
  aliases: string[];
}

export const TARGET_FIELD_DEFINITIONS: Record<TargetInvoiceField, FieldDefinition> = {
  invoice_number: {
    field: "invoice_number",
    label: "Invoice Number",
    required: true,
    description: "Unique invoice identifier",
    aliases: [
      "invoice_number", "invoicenumber", "invoice_no", "invoiceno",
      "inv_number", "invnumber", "inv_no", "invno", "inv #", "inv#",
      "invoice #", "invoice#", "invoice id", "invoice_id", "bill number",
      "bill_number", "bill no", "bill_no", "bill #", "bill#", "doc number",
      "doc_no", "doc #", "voucher_number", "voucher_no", "invoice"
    ]
  },
  vendor_name: {
    field: "vendor_name",
    label: "Vendor Name",
    required: true,
    description: "Supplier or vendor business name",
    aliases: [
      "vendor_name", "vendorname", "vendor", "supplier_name", "suppliername",
      "supplier", "supplier_company", "supplier company", "vendor_company", "vendor company",
      "seller_name", "seller", "payee_name", "payee", "company_name",
      "company", "party_name", "biller_name", "biller", "account_name"
    ]
  },
  vendor_tax_id: {
    field: "vendor_tax_id",
    label: "Vendor Tax ID / NTN",
    required: false,
    description: "Vendor NTN, STRN, TIN, VAT, or GST number",
    aliases: [
      "vendor_tax_id", "vendortaxid", "tax_id", "taxid", "tax_no", "tax_number",
      "tax number", "vendor_ntn", "vendorntn", "ntn", "ntn_no", "ntn_number",
      "strn", "strn_no", "vat_number", "vat_no", "vat #", "vat", "gstin",
      "gst_no", "gst_number", "tin", "trn"
    ]
  },
  invoice_date: {
    field: "invoice_date",
    label: "Invoice Date",
    required: false,
    description: "Issue or billing date of the invoice",
    aliases: [
      "invoice_date", "invoicedate", "inv_date", "invdate", "date",
      "bill_date", "billdate", "doc_date", "doc date", "document_date",
      "issue_date", "issued_date", "posting_date", "txn_date", "transaction_date"
    ]
  },
  due_date: {
    field: "due_date",
    label: "Due Date",
    required: true,
    description: "Payment maturity or due date",
    aliases: [
      "due_date", "duedate", "payment_due_date", "payment due date", "payment_due",
      "payment due", "pay_due_date", "pay due", "expiry_date", "maturity_date",
      "net_due_date", "terms_due_date", "due"
    ]
  },
  amount: {
    field: "amount",
    label: "Total Amount",
    required: true,
    description: "Total payable amount",
    aliases: [
      "amount", "total_amount", "totalamount", "total", "net_amount",
      "netamount", "gross_amount", "gross amount", "grossamount",
      "invoice_amount", "invoiceamount", "bill_amount", "billamount",
      "total_due", "total due", "balance_due", "balance due", "amount_due",
      "amount due", "grand_total", "grand total", "total_payable", "total payable"
    ]
  },
  currency: {
    field: "currency",
    label: "Currency",
    required: false,
    description: "ISO 3-letter currency code (e.g. PKR, USD)",
    aliases: [
      "currency", "currency_code", "currencycode", "curr", "ccy", "curr_code"
    ]
  },
  po_number: {
    field: "po_number",
    label: "Purchase Order (PO #)",
    required: false,
    description: "Linked Purchase Order number for 3-way matching",
    aliases: [
      "po_number", "ponumber", "po_no", "pono", "po #", "po#",
      "purchase_order", "purchase_order_number", "purchase order number",
      "purchase_order_no", "purchase order #", "purchase order", "po_reference",
      "po ref", "po ref #", "p.o.", "order_number", "order_no", "order #"
    ]
  },
  grn_number: {
    field: "grn_number",
    label: "Goods Receipt (GRN #)",
    required: false,
    description: "Linked Goods Receipt Note number for 3-way matching",
    aliases: [
      "grn_number", "grnnumber", "grn_no", "grnno", "grn #", "grn#",
      "goods_receipt", "goods_receipt_number", "goods receipt number",
      "goods_receipt_no", "goods receipt #", "goods_receipt_note",
      "grn_reference", "grn ref", "grn ref #", "delivery_note", "delivery note",
      "delivery_note_no", "delivery note #", "delivery note number",
      "receiving_number", "receiving_no", "receiving #"
    ]
  },
  line_items_description: {
    field: "line_items_description",
    label: "Line Items / Description",
    required: false,
    description: "Summary or item description for matching",
    aliases: [
      "line_items_description", "line_item_description", "item_description",
      "item description", "items_description", "item_details", "item details",
      "description", "item_name", "item name", "item", "items", "particulars",
      "details", "line_items", "line_item", "product_name", "product"
    ]
  },
  payment_terms: {
    field: "payment_terms",
    label: "Payment Terms",
    required: false,
    description: "Payment terms (e.g. Net 30, COD)",
    aliases: [
      "payment_terms", "paymentterms", "terms", "terms_of_payment",
      "payment_term", "pay_terms", "credit_terms", "credit terms", "term"
    ]
  },
  vendor_bank_name: {
    field: "vendor_bank_name",
    label: "Vendor Bank Name",
    required: false,
    description: "Name of the vendor's bank, for payment runs",
    aliases: [
      "vendor_bank_name", "vendorbankname", "bank_name", "bankname",
      "bank", "beneficiary_bank", "beneficiary bank", "payee_bank", "payee bank"
    ]
  },
  vendor_account_number: {
    field: "vendor_account_number",
    label: "Vendor Account Number",
    required: false,
    description: "Vendor's bank account number, for payment runs",
    aliases: [
      "vendor_account_number", "vendoraccountnumber", "account_number", "accountnumber",
      "account_no", "acc_no", "acc_number", "bank_account_number", "bank_account_no",
      "beneficiary_account", "beneficiary account"
    ]
  },
  vendor_iban: {
    field: "vendor_iban",
    label: "Vendor IBAN",
    required: false,
    description: "Vendor's IBAN, for payment runs",
    aliases: [
      "vendor_iban", "vendoriban", "iban", "iban_number", "iban_no",
      "beneficiary_iban", "beneficiary iban"
    ]
  }
};

export function normalizeHeaderString(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[_\-\.\s]+/g, "_")
    .replace(/[^a-z0-9_#]/g, "");
}

/**
 * Computes exact normalized alias matching between detected CSV columns and our schema fields.
 * No fuzzy or AI hallucination — strict deterministic alias lookup.
 */
export function suggestColumnMapping(detectedColumns: string[]): Record<TargetInvoiceField, string | null> {
  const mapping: Record<TargetInvoiceField, string | null> = {
    invoice_number: null,
    vendor_name: null,
    vendor_tax_id: null,
    invoice_date: null,
    due_date: null,
    amount: null,
    currency: null,
    po_number: null,
    grn_number: null,
    line_items_description: null,
    payment_terms: null,
    vendor_bank_name: null,
    vendor_account_number: null,
    vendor_iban: null
  };

  const normalizedDetected = detectedColumns.map((col) => ({
    original: col,
    normalized: normalizeHeaderString(col)
  }));

  for (const field of ALL_INVOICE_FIELDS) {
    const def = TARGET_FIELD_DEFINITIONS[field];
    const normalizedAliases = def.aliases.map(normalizeHeaderString);

    // Try finding exact match among aliases
    for (const item of normalizedDetected) {
      if (normalizedAliases.includes(item.normalized)) {
        mapping[field] = item.original;
        break;
      }
    }
  }

  return mapping;
}

/**
 * Validates that all required invoice fields have been mapped to a valid column.
 */
export function validateRequiredMappings(
  mapping: Record<string, string | null | undefined>,
  detectedColumns?: string[]
): { valid: boolean; missing: string[]; invalid: string[] } {
  const missing: string[] = [];
  const invalid: string[] = [];

  const detectedSet = detectedColumns ? new Set(detectedColumns) : null;

  for (const reqField of REQUIRED_INVOICE_FIELDS) {
    const sourceCol = mapping[reqField];
    if (!sourceCol || !sourceCol.trim()) {
      missing.push(reqField);
    } else if (detectedSet && !detectedSet.has(sourceCol)) {
      invalid.push(`${reqField} mapped to non-existent column '${sourceCol}'`);
    }
  }

  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid
  };
}
