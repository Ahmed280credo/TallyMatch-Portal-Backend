export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type InvoiceStatus =
  | "queued"
  | "extracted"
  | "approved"
  | "pending_review"
  | "pending"
  | "mismatch"
  | "failed"
  | "queued_for_payment"
  | "payment_processing"
  | "paid";
export type MatchStatus = "matched" | "mismatch" | "pending";
export type AuditEvent =
  | "DUPLICATE_DETECTED"
  | "EXTRACTION_FAILED"
  | "MATCH_FAILED"
  | "APPROVED"
  | "PROCESSED"
  | "PAID"
  | "DELETED"
  | "ERP_PUSHED"
  | "ERP_PUSH_FAILED"
  | "ERP_PAYMENT_SYNCED";
export type FbrStatus = "Active" | "Suspended" | "Unregistered";

export interface InvoiceLineItem {
  sku?: string | null;
  item_sku?: string | null;
  description: string;
  quantity?: number | null;
  unit_price?: number | null;
  amount: number;
}

export type ErpPushStatus = "not_pushed" | "pushed" | "failed";
export type PaymentSource = "manual" | "erp_sync";
// 'bundle_extracted' = pulled from a paper bundle upload (Phase 1) rather than
// typed manually, CSV-imported, or synced live from an ERP. Precedence for
// matching/insertion purposes is erp_sync > manual/csv_import > bundle_extracted
// — see BundleAssemblyService.
export type RecordSource = "manual" | "csv_import" | "erp_sync" | "bundle_extracted";
export type ErpConnectionStatus = "connected" | "disconnected" | "error";

// ── Bundle extraction v2 (Phase 1) ──────────────────────────────────────────
// Structured finding emitted during extraction or matching. Non-breaking:
// mismatch_reasons/pending_reasons (inside match_result) stay populated from
// finding messages so the existing frontend needs no change yet. Codes
// actually produced in Phase 1 (extraction-time, all REVIEW or INFO —
// nothing in this phase can BLOCK, since amount/qty variance detection stays
// in the unchanged Phase-2-owned ThreeWayMatchingService): MISSING_PO,
// MISSING_GRN, MISSING_SUPPLIER_TAX_ID, DATE_ANOMALY, LOW_CONFIDENCE,
// EVIDENCE_MISMATCH, DUPLICATE_ITEM_CODE, DOC_MISMATCH,
// VISION_TEXT_MISMATCH, LINE_MATH_MISMATCH. PRICE_VARIANCE, QTY_OVER_RECEIPT,
// PARTIAL_RECEIPT, DAMAGE_NOTE, and TAX_ID_MISMATCH belong to the Phase 2
// matching engine.
export type FindingSeverity = "BLOCK" | "REVIEW" | "INFO";
export type FindingCode =
  | "PRICE_VARIANCE"
  | "QTY_OVER_RECEIPT"
  | "PARTIAL_RECEIPT"
  | "DAMAGE_NOTE"
  | "MISSING_PO"
  | "MISSING_GRN"
  | "TAX_ID_MISMATCH"
  | "MISSING_SUPPLIER_TAX_ID"
  | "DUPLICATE_ITEM_CODE"
  | "DATE_ANOMALY"
  | "DOC_MISMATCH"
  | "EVIDENCE_MISMATCH"
  | "LOW_CONFIDENCE"
  // Added in Phase 1, not in the original spec list — needed for the
  // vision-vs-text-layer cross-check and the server-side line-math recompute
  // the spec explicitly asks for.
  | "VISION_TEXT_MISMATCH"
  | "LINE_MATH_MISMATCH";

export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  message: string;
  line_ref?: string | null;
  evidence?: Json;
}

export type PageType = "invoice" | "cash_memo" | "po" | "delivery_note" | "grn" | "blank" | "other";

export interface PageClassification {
  page_index: number;
  page_type: PageType;
  document_number: string | null;
  confidence: number;
}

export interface Bundle {
  id: string;
  org_id: string;
  source_file_name: string | null;
  file_hash: string;
  page_count: number | null;
  page_classification: PageClassification[] | null;
  extraction_mode: "erp" | "paper_only";
  prompt_version: string | null;
  model_name: string | null;
  raw_gemini_response: Json | null;
  created_at: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  extraction_v2_enabled: boolean;
  created_at: string;
}

export interface Invoice {
  id: string;
  org_id: string;
  vendor_name: string | null;
  vendor_ntn: string | null;
  vendor_tax_id?: string | null;
  invoice_number: string | null;
  po_number: string | null;
  grn_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  currency: string | null;
  payment_terms: string | null;
  line_items: InvoiceLineItem[] | null;
  fbr_status: FbrStatus | null;
  match_status: MatchStatus | null;
  match_result: Json | null;
  status: InvoiceStatus;
  source_file_name: string | null;
  intake_source?: string | null;
  payment_run_id: string | null;
  proof_of_payment_url: string | null;
  transaction_reference: string | null;
  payment_date: string | null;
  amount_paid: number | null;
  payment_amount_mismatch: boolean;
  vendor_bank_name: string | null;
  vendor_account_number: string | null;
  vendor_iban: string | null;
  // ERP push (invoice -> ERP) and payment sync (ERP -> invoice) tracking.
  // erp_type is nullable/independent of erp_connections.erp_type so a past
  // push record still makes sense if the org's active connection later
  // changes to a different ERP.
  erp_type: string | null;
  erp_push_status: ErpPushStatus;
  erp_doc_entry: number | null;
  erp_doc_num: number | null;
  erp_push_error: string | null;
  erp_pushed_at: string | null;
  payment_source: PaymentSource | null;
  erp_last_synced_at: string | null;
  // Bundle extraction v2 (Phase 1) — null/empty for single-PDF and
  // CSV-imported invoices, unchanged this phase.
  bundle_id: string | null;
  extraction_metadata: Json | null;
  findings: Finding[];
  created_at: string;
  updated_at: string;
}

export interface PaymentRun {
  id: string;
  org_id: string;
  created_by: string | null;
  created_at: string;
  total_amount: number;
  invoice_count: number;
}

export interface PurchaseOrder {
  id: string;
  org_id: string;
  po_number: string;
  vendor_name: string | null;
  total_amount: number | null;
  currency: string | null;
  line_items: InvoiceLineItem[] | null;
  source: RecordSource;
  erp_type: string | null;
  erp_doc_entry: number | null;
  erp_doc_num: number | null;
  // Bundle extraction v2 (Phase 1). is_superseded is schema-only this phase —
  // nothing sets it to true yet (that happens when ERP sync later brings the
  // same document; out of scope here, see the migration's comment).
  bundle_id: string | null;
  invoice_id: string | null;
  is_superseded: boolean;
  created_at: string;
}

export interface GoodsReceiptNote {
  id: string;
  org_id: string;
  grn_number: string;
  po_number: string | null;
  vendor_name: string | null;
  total_received_amount: number | null;
  line_items: InvoiceLineItem[] | null;
  received_at: string | null;
  source: RecordSource;
  erp_type: string | null;
  erp_doc_entry: number | null;
  erp_doc_num: number | null;
  bundle_id: string | null;
  invoice_id: string | null;
  is_superseded: boolean;
  created_at: string;
}

export interface ErpConnection {
  id: string;
  org_id: string;
  erp_type: string;
  base_url: string;
  company_db: string | null;
  username: string;
  password_encrypted: string;
  status: ErpConnectionStatus;
  status_message: string | null;
  last_tested_at: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceAuditLog {
  id: string;
  org_id: string;
  invoice_id: string | null;
  invoice_number: string | null;
  vendor_name: string | null;
  event: AuditEvent;
  status: string;
  total_amount: number | null;
  notes: string | null;
  metadata: Json | null;
  processed_at: string;
}

export interface TempCsvUpload {
  id: string;
  org_id: string;
  uploaded_by: string | null;
  file_name: string;
  storage_path: string | null;
  file_content: string;
  detected_columns: string[];
  sample_rows: Record<string, string>[];
  expires_at: string;
  created_at: string;
}

export interface SavedCsvMapping {
  id: string;
  org_id: string;
  name: string;
  column_mapping: Record<string, string | null>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Database {
  public: {
    Tables: {
      invoices: {
        Row: Invoice;
        Insert: Partial<Omit<Invoice, "id" | "created_at" | "updated_at">> & Pick<Invoice, "org_id" | "status">;
        Update: Partial<Omit<Invoice, "id" | "org_id" | "created_at">>;
        Relationships: [];
      };
      purchase_orders: {
        Row: PurchaseOrder;
        Insert: Partial<Omit<PurchaseOrder, "id" | "created_at">> & Pick<PurchaseOrder, "org_id" | "po_number">;
        Update: Partial<Omit<PurchaseOrder, "id" | "org_id" | "created_at">>;
        Relationships: [];
      };
      goods_receipt_notes: {
        Row: GoodsReceiptNote;
        Insert: Partial<Omit<GoodsReceiptNote, "id" | "created_at">> & Pick<GoodsReceiptNote, "org_id" | "grn_number">;
        Update: Partial<Omit<GoodsReceiptNote, "id" | "org_id" | "created_at">>;
        Relationships: [];
      };
      invoice_audit_log: {
        Row: InvoiceAuditLog;
        Insert: Partial<Omit<InvoiceAuditLog, "id">> & Pick<InvoiceAuditLog, "org_id" | "event" | "status" | "processed_at">;
        Update: never;
        Relationships: [];
      };
      temp_csv_uploads: {
        Row: TempCsvUpload;
        Insert: Partial<Omit<TempCsvUpload, "id" | "created_at">> & Pick<TempCsvUpload, "org_id" | "file_name" | "file_content" | "detected_columns" | "sample_rows">;
        Update: Partial<Omit<TempCsvUpload, "id" | "org_id" | "created_at">>;
        Relationships: [];
      };
      saved_csv_mappings: {
        Row: SavedCsvMapping;
        Insert: Partial<Omit<SavedCsvMapping, "id" | "created_at" | "updated_at">> & Pick<SavedCsvMapping, "org_id" | "name" | "column_mapping">;
        Update: Partial<Omit<SavedCsvMapping, "id" | "org_id" | "created_at">>;
        Relationships: [];
      };
      payment_runs: {
        Row: PaymentRun;
        Insert: Partial<Omit<PaymentRun, "id" | "created_at">> & Pick<PaymentRun, "org_id">;
        Update: Partial<Omit<PaymentRun, "id" | "org_id" | "created_at">>;
        Relationships: [];
      };
      erp_connections: {
        Row: ErpConnection;
        Insert: Partial<Omit<ErpConnection, "id" | "created_at" | "updated_at">> &
          Pick<ErpConnection, "org_id" | "base_url" | "username" | "password_encrypted">;
        Update: Partial<Omit<ErpConnection, "id" | "org_id" | "created_at">>;
        Relationships: [];
      };
      bundles: {
        Row: Bundle;
        Insert: Partial<Omit<Bundle, "id" | "created_at">> & Pick<Bundle, "org_id" | "file_hash">;
        Update: Partial<Omit<Bundle, "id" | "org_id" | "created_at">>;
        Relationships: [];
      };
      organizations: {
        Row: Organization;
        Insert: Partial<Omit<Organization, "id" | "created_at">> & Pick<Organization, "name" | "slug">;
        Update: Partial<Omit<Organization, "id" | "created_at">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

