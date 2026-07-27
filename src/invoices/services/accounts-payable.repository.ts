import { Inject, Injectable } from "@nestjs/common";
import { SUPABASE_CLIENT } from "../../database/supabase.client.js";
import type {
  Database,
  GoodsReceiptNote,
  Invoice,
  InvoiceAuditLog,
  PurchaseOrder
} from "../types/database.js";

type InvoiceInsert = Database["public"]["Tables"]["invoices"]["Insert"];
type InvoiceUpdate = Database["public"]["Tables"]["invoices"]["Update"];
type AuditInsert = Database["public"]["Tables"]["invoice_audit_log"]["Insert"];

function requireOrgId(orgId: string) {
  if (!orgId || orgId.trim().length < 8) {
    throw new Error("Refusing unscoped database query: org_id is required");
  }
}

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) {
    throw new Error(error.message);
  }
  return data as T;
}

@Injectable()
export class AccountsPayableRepository {
  constructor(
    @Inject(SUPABASE_CLIENT)
    private readonly supabase: any
  ) {}

  async findInvoiceByNumber(orgId: string, invoiceNumber: string): Promise<Invoice | null> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("invoices")
      .select("*")
      .eq("org_id", orgId)
      .eq("invoice_number", invoiceNumber)
      .maybeSingle();

    return unwrap(data, error);
  }

  async createInvoice(orgId: string, invoice: Omit<InvoiceInsert, "org_id">): Promise<Invoice> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("invoices")
      .insert({ ...invoice, org_id: orgId })
      .select("*")
      .single();

    return unwrap(data, error);
  }

  async updateInvoice(orgId: string, invoiceId: string, patch: InvoiceUpdate): Promise<Invoice> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("invoices")
      .update(patch)
      .eq("org_id", orgId)
      .eq("id", invoiceId)
      .select("*")
      .single();

    return unwrap(data, error);
  }

  async listPurchaseOrders(orgId: string): Promise<PurchaseOrder[]> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("purchase_orders")
      .select("*")
      .eq("org_id", orgId);

    return unwrap(data, error);
  }

  async listGoodsReceiptNotes(orgId: string): Promise<GoodsReceiptNote[]> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("goods_receipt_notes")
      .select("*")
      .eq("org_id", orgId);

    return unwrap(data, error);
  }

  async insertAuditLog(orgId: string, entry: Omit<AuditInsert, "org_id" | "processed_at">): Promise<void> {
    requireOrgId(orgId);

    const { error } = await this.supabase
      .from("invoice_audit_log")
      .insert({
        ...entry,
        org_id: orgId,
        processed_at: new Date().toISOString()
      });

    if (error) throw new Error(`invoice_audit_log insert failed — ${error.message} | code: ${error.code} | details: ${error.details ?? "none"}`);
  }
}

