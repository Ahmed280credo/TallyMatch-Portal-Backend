export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type InvoiceStatus = "queued" | "extracted" | "approved" | "pending_review" | "pending" | "mismatch" | "failed";
export type MatchStatus = "matched" | "mismatch" | "pending";
export type AuditEvent = "DUPLICATE_DETECTED" | "EXTRACTION_FAILED" | "MATCH_FAILED" | "APPROVED" | "PROCESSED";
export type FbrStatus = "Active" | "Suspended" | "Unregistered";

export interface InvoiceLineItem {
  sku?: string | null;
  item_sku?: string | null;
  description: string;
  quantity?: number | null;
  unit_price?: number | null;
  amount: number;
}

export interface Invoice {
  id: string;
  org_id: string;
  vendor_name: string | null;
  vendor_ntn: string | null;
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
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrder {
  id: string;
  org_id: string;
  po_number: string;
  vendor_name: string | null;
  total_amount: number | null;
  currency: string | null;
  line_items: InvoiceLineItem[] | null;
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
  created_at: string;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

