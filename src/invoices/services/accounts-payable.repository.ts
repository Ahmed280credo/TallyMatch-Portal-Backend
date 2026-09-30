import { Inject, Injectable } from "@nestjs/common";
import { SUPABASE_CLIENT } from "../../database/supabase.client.js";
import type {
  Bundle,
  Database,
  GoodsReceiptNote,
  Invoice,
  InvoiceAuditLog,
  OrgMatchSettings,
  Organization,
  PaymentRun,
  PurchaseOrder
} from "../types/database.js";

type InvoiceInsert = Database["public"]["Tables"]["invoices"]["Insert"];
type InvoiceUpdate = Database["public"]["Tables"]["invoices"]["Update"];
type AuditInsert = Database["public"]["Tables"]["invoice_audit_log"]["Insert"];
type PaymentRunInsert = Database["public"]["Tables"]["payment_runs"]["Insert"];
type BundleInsert = Database["public"]["Tables"]["bundles"]["Insert"];
type PurchaseOrderInsert = Database["public"]["Tables"]["purchase_orders"]["Insert"];
type GoodsReceiptNoteInsert = Database["public"]["Tables"]["goods_receipt_notes"]["Insert"];

export interface PaymentQueueFilters {
  sortBy: "due_date" | "vendor_name" | "amount";
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
  vendorName?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
}

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

// Matches the SQL expression in invoices_org_vendor_invoice_number_unique:
// regexp_replace(lower(btrim(vendor_name)), '\s+', ' ', 'g').
function normalizeVendorName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

@Injectable()
export class AccountsPayableRepository {
  constructor(
    @Inject(SUPABASE_CLIENT)
    private readonly supabase: any
  ) {}

  // Mirrors the two DB unique indexes exactly: invoices_org_vendor_invoice_number_unique
  // (normalised vendor + invoice_number, both present) and
  // invoices_org_invoice_number_no_vendor_unique (invoice_number alone, when
  // vendor_name is null on both sides). Normalisation happens here in app
  // code rather than via a DB-side .ilike()/expression filter, since
  // PostgREST has no clean way to apply the same regexp_replace the unique
  // index uses — invoice_number matches are rare enough per org that
  // fetching the (usually 0-1) candidates and comparing normalised vendor
  // names in memory is simpler and provably matches the index's semantics.
  async findInvoiceByNumber(orgId: string, invoiceNumber: string, vendorName?: string | null): Promise<Invoice | null> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("invoices")
      .select("*")
      .eq("org_id", orgId)
      .eq("invoice_number", invoiceNumber);

    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Invoice[];

    const trimmedVendor = vendorName?.trim();
    if (trimmedVendor) {
      const target = normalizeVendorName(trimmedVendor);
      return rows.find((r) => r.vendor_name != null && normalizeVendorName(r.vendor_name) === target) ?? null;
    }
    return rows.find((r) => r.vendor_name == null) ?? null;
  }

  async deleteInvoice(orgId: string, invoiceId: string): Promise<void> {
    requireOrgId(orgId);

    const { error } = await this.supabase
      .from("invoices")
      .delete()
      .eq("org_id", orgId)
      .eq("id", invoiceId);

    if (error) {
      throw new Error(error.message);
    }
  }

  async createInvoice(orgId: string, invoice: Omit<InvoiceInsert, "org_id">): Promise<Invoice> {
    requireOrgId(orgId);

    const payload: any = { ...invoice, org_id: orgId };

    // Auto-fallback: newly added optional columns may not exist yet in the DB schema cache.
    // PostgREST reports one missing column per error, so retry repeatedly, stripping one at a time.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await this.supabase
        .from("invoices")
        .insert(payload)
        .select("*")
        .single();

      if (!error) return data as Invoice;

      const missingColumn = error.message?.match(/Could not find the '([^']+)' column/)?.[1];
      if (!missingColumn || !(missingColumn in payload)) {
        return unwrap(data, error);
      }
      delete payload[missingColumn];
    }

    throw new Error("Failed to insert invoice: too many missing schema-cache columns");
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

  async saveTempUpload(
    orgId: string,
    upload: {
      fileName: string;
      fileContent: string;
      detectedColumns: string[];
      sampleRows: Record<string, string>[];
      uploadedBy?: string | null;
      storagePath?: string | null;
    }
  ): Promise<import("../types/database.js").TempCsvUpload> {
    requireOrgId(orgId);

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const { data, error } = await this.supabase
      .from("temp_csv_uploads")
      .insert({
        org_id: orgId,
        uploaded_by: upload.uploadedBy ?? null,
        file_name: upload.fileName,
        storage_path: upload.storagePath ?? null,
        file_content: upload.fileContent,
        detected_columns: upload.detectedColumns,
        sample_rows: upload.sampleRows,
        expires_at: expiresAt
      })
      .select("*")
      .single();

    return unwrap(data, error);
  }

  async getTempUpload(orgId: string, uploadId: string): Promise<import("../types/database.js").TempCsvUpload | null> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("temp_csv_uploads")
      .select("*")
      .eq("org_id", orgId)
      .eq("id", uploadId)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    return unwrap(data, error);
  }

  async deleteTempUpload(orgId: string, uploadId: string): Promise<void> {
    requireOrgId(orgId);

    const { error } = await this.supabase
      .from("temp_csv_uploads")
      .delete()
      .eq("org_id", orgId)
      .eq("id", uploadId);

    if (error) throw new Error(error.message);
  }

  async cleanupExpiredUploads(orgId?: string): Promise<number> {
    const now = new Date().toISOString();
    let query = this.supabase
      .from("temp_csv_uploads")
      .delete()
      .lt("expires_at", now);

    if (orgId) {
      query = query.eq("org_id", orgId);
    }

    const { count, error } = await query;
    if (error) {
      return 0;
    }
    return count ?? 0;
  }

  async saveCsvMapping(
    orgId: string,
    name: string,
    columnMapping: Record<string, string | null>,
    userId?: string | null
  ): Promise<import("../types/database.js").SavedCsvMapping> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("saved_csv_mappings")
      .upsert(
        {
          org_id: orgId,
          name: name.trim(),
          column_mapping: columnMapping,
          created_by: userId ?? null,
          updated_at: new Date().toISOString()
        },
        { onConflict: "org_id,name" }
      )
      .select("*")
      .single();

    return unwrap(data, error);
  }

  async listSavedCsvMappings(orgId: string): Promise<import("../types/database.js").SavedCsvMapping[]> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("saved_csv_mappings")
      .select("*")
      .eq("org_id", orgId)
      .order("name", { ascending: true });

    return unwrap(data, error);
  }

  // ── Payment queue ──────────────────────────────────────────────────────

  async listQueuedForPayment(
    orgId: string,
    filters: PaymentQueueFilters
  ): Promise<{ rows: Invoice[]; total: number }> {
    requireOrgId(orgId);

    const sortColumn: Record<PaymentQueueFilters["sortBy"], string> = {
      due_date: "due_date",
      vendor_name: "vendor_name",
      amount: "total_amount"
    };

    let query = this.supabase
      .from("invoices")
      .select("*", { count: "exact" })
      .eq("org_id", orgId)
      .eq("status", "queued_for_payment");

    if (filters.vendorName) {
      query = query.ilike("vendor_name", `%${filters.vendorName}%`);
    }
    if (filters.dueDateFrom) {
      query = query.gte("due_date", filters.dueDateFrom);
    }
    if (filters.dueDateTo) {
      query = query.lte("due_date", filters.dueDateTo);
    }

    const from = (filters.page - 1) * filters.pageSize;
    const to = from + filters.pageSize - 1;

    const { data, error, count } = await query
      .order(sortColumn[filters.sortBy], { ascending: filters.sortDir === "asc" })
      .range(from, to);

    return { rows: unwrap(data, error), total: count ?? 0 };
  }

  async getInvoicesByIds(orgId: string, invoiceIds: string[]): Promise<Invoice[]> {
    requireOrgId(orgId);
    if (invoiceIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from("invoices")
      .select("*")
      .eq("org_id", orgId)
      .in("id", invoiceIds);

    return unwrap(data, error);
  }

  async listQueuedForPaymentByDueDateRange(
    orgId: string,
    dueDateFrom?: string,
    dueDateTo?: string
  ): Promise<Invoice[]> {
    requireOrgId(orgId);

    let query = this.supabase
      .from("invoices")
      .select("*")
      .eq("org_id", orgId)
      .eq("status", "queued_for_payment");

    if (dueDateFrom) query = query.gte("due_date", dueDateFrom);
    if (dueDateTo) query = query.lte("due_date", dueDateTo);

    const { data, error } = await query;
    return unwrap(data, error);
  }

  async getInvoiceById(orgId: string, invoiceId: string): Promise<Invoice | null> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("invoices")
      .select("*")
      .eq("org_id", orgId)
      .eq("id", invoiceId)
      .maybeSingle();

    return unwrap(data, error);
  }

  async createPaymentRun(
    orgId: string,
    payload: Omit<PaymentRunInsert, "org_id">
  ): Promise<PaymentRun> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("payment_runs")
      .insert({ ...payload, org_id: orgId })
      .select("*")
      .single();

    return unwrap(data, error);
  }

  async linkInvoicesToPaymentRun(
    orgId: string,
    invoiceIds: string[],
    paymentRunId: string
  ): Promise<Invoice[]> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("invoices")
      .update({ payment_run_id: paymentRunId, status: "payment_processing" })
      .eq("org_id", orgId)
      .in("id", invoiceIds)
      .select("*");

    return unwrap(data, error);
  }

  async listPaymentRuns(
    orgId: string,
    page: number,
    pageSize: number
  ): Promise<{ rows: PaymentRun[]; total: number }> {
    requireOrgId(orgId);

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await this.supabase
      .from("payment_runs")
      .select("*", { count: "exact" })
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .range(from, to);

    return { rows: unwrap(data, error), total: count ?? 0 };
  }

  async getPaymentRunById(orgId: string, paymentRunId: string): Promise<PaymentRun | null> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("payment_runs")
      .select("*")
      .eq("org_id", orgId)
      .eq("id", paymentRunId)
      .maybeSingle();

    return unwrap(data, error);
  }

  async getInvoicesByPaymentRun(orgId: string, paymentRunId: string): Promise<Invoice[]> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("invoices")
      .select("*")
      .eq("org_id", orgId)
      .eq("payment_run_id", paymentRunId);

    return unwrap(data, error);
  }

  async listInvoiceStatusesForPaymentRuns(
    orgId: string,
    paymentRunIds: string[]
  ): Promise<{ payment_run_id: string; status: string }[]> {
    requireOrgId(orgId);
    if (paymentRunIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from("invoices")
      .select("payment_run_id, status")
      .eq("org_id", orgId)
      .in("payment_run_id", paymentRunIds);

    return unwrap(data, error);
  }

  // ── Bundle extraction v2 (Phase 1) ────────────────────────────────────────

  async getOrganization(orgId: string): Promise<Organization | null> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("organizations")
      .select("*")
      .eq("id", orgId)
      .maybeSingle();

    return unwrap(data, error);
  }

  // Cache key is (org_id, file_hash, prompt_version) — an exact re-upload is
  // only reused if it was extracted with the CURRENT prompt version; a prompt
  // bump makes a previously-cached bundle a cache miss, so it re-extracts
  // instead of silently serving stale output.
  async findBundleByFileHash(orgId: string, fileHash: string, promptVersion: string): Promise<Bundle | null> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("bundles")
      .select("*")
      .eq("org_id", orgId)
      .eq("file_hash", fileHash)
      .eq("prompt_version", promptVersion)
      .maybeSingle();

    return unwrap(data, error);
  }

  async createBundle(orgId: string, bundle: Omit<BundleInsert, "org_id">): Promise<Bundle> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("bundles")
      .insert({ ...bundle, org_id: orgId })
      .select("*")
      .single();

    return unwrap(data, error);
  }

  async getPurchaseOrderByNumber(orgId: string, poNumber: string): Promise<PurchaseOrder | null> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("purchase_orders")
      .select("*")
      .eq("org_id", orgId)
      .eq("po_number", poNumber)
      .maybeSingle();

    return unwrap(data, error);
  }

  async getGoodsReceiptNoteByNumber(orgId: string, grnNumber: string): Promise<GoodsReceiptNote | null> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("goods_receipt_notes")
      .select("*")
      .eq("org_id", orgId)
      .eq("grn_number", grnNumber)
      .maybeSingle();

    return unwrap(data, error);
  }

  // Caller (BundleAssemblyService) has already decided this write is safe —
  // either no row exists for this po_number, or the existing one is itself
  // bundle_extracted (refining the same evidence). Never call this when a
  // higher-trust row (manual/csv_import/erp_sync) already exists.
  async upsertBundlePurchaseOrder(orgId: string, po: Omit<PurchaseOrderInsert, "org_id">): Promise<PurchaseOrder> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("purchase_orders")
      .upsert({ ...po, org_id: orgId, source: "bundle_extracted" }, { onConflict: "org_id,po_number" })
      .select("*")
      .single();

    return unwrap(data, error);
  }

  async upsertBundleGoodsReceiptNote(orgId: string, grn: Omit<GoodsReceiptNoteInsert, "org_id">): Promise<GoodsReceiptNote> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("goods_receipt_notes")
      .upsert({ ...grn, org_id: orgId, source: "bundle_extracted" }, { onConflict: "org_id,grn_number" })
      .select("*")
      .single();

    return unwrap(data, error);
  }

  async listInvoicesByBundle(orgId: string, bundleId: string): Promise<Invoice[]> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("invoices")
      .select("*")
      .eq("org_id", orgId)
      .eq("bundle_id", bundleId);

    return unwrap(data, error);
  }

  // Called once, by whichever invoice in the bundle first references this
  // PO/GRN by number — see BundleAssemblyService. invoice_id being non-null
  // is what the matcher requires before it will ever use a bundle_extracted
  // row at all; bundle_id (already set at insert time) is the actual scoping
  // key that lets a second invoice in the same bundle reuse the same evidence.
  async linkPurchaseOrderToInvoice(orgId: string, purchaseOrderId: string, invoiceId: string): Promise<void> {
    requireOrgId(orgId);

    const { error } = await this.supabase
      .from("purchase_orders")
      .update({ invoice_id: invoiceId })
      .eq("org_id", orgId)
      .eq("id", purchaseOrderId);

    if (error) throw new Error(error.message);
  }

  async linkGoodsReceiptNoteToInvoice(orgId: string, goodsReceiptNoteId: string, invoiceId: string): Promise<void> {
    requireOrgId(orgId);

    const { error } = await this.supabase
      .from("goods_receipt_notes")
      .update({ invoice_id: invoiceId })
      .eq("org_id", orgId)
      .eq("id", goodsReceiptNoteId);

    if (error) throw new Error(error.message);
  }

  // Defaults to requiring ERP verification (matches the DB column default)
  // when no row exists for the org yet — an org must explicitly opt out,
  // not implicitly get a permissive default just because it never visited
  // a settings page for this.
  async getOrgMatchSettings(orgId: string): Promise<OrgMatchSettings> {
    requireOrgId(orgId);

    const { data, error } = await this.supabase
      .from("org_match_settings")
      .select("*")
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (data) return data as OrgMatchSettings;

    return {
      org_id: orgId,
      require_erp_verification_for_approval: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    };
  }
}

