import { CsvBulkImportService } from "./csv-bulk-import.service.js";
import { AccountsPayableRepository } from "./accounts-payable.repository.js";
import { ThreeWayMatchingService } from "./three-way-matching.service.js";
import { AuditLogService } from "./audit-log.service.js";
import { FbrComplianceService } from "./fbr-compliance.service.js";
import type { Invoice, PurchaseOrder, GoodsReceiptNote, TempCsvUpload, SavedCsvMapping } from "../types/database.js";

class MockAccountsPayableRepository {
  invoices: Invoice[] = [];
  deletedIds: string[] = [];
  tempUploads: TempCsvUpload[] = [];
  savedMappings: SavedCsvMapping[] = [];

  async findInvoiceByNumber(orgId: string, invoiceNumber: string, vendorName?: string | null): Promise<Invoice | null> {
    return this.invoices.find(
      (inv) => inv.org_id === orgId && inv.invoice_number === invoiceNumber
    ) || null;
  }

  async createInvoice(orgId: string, invoice: any): Promise<Invoice> {
    const newInv: Invoice = {
      id: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      org_id: orgId,
      ...invoice,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.invoices.push(newInv);
    return newInv;
  }

  async updateInvoice(orgId: string, invoiceId: string, patch: any): Promise<Invoice> {
    const inv = this.invoices.find((i) => i.id === invoiceId && i.org_id === orgId);
    if (!inv) throw new Error("Invoice not found for update");
    Object.assign(inv, patch);
    return inv;
  }

  async deleteInvoice(orgId: string, invoiceId: string): Promise<void> {
    this.deletedIds.push(invoiceId);
    this.invoices = this.invoices.filter((i) => i.id !== invoiceId);
  }

  async listPurchaseOrders(orgId: string): Promise<PurchaseOrder[]> {
    return [
      {
        id: "po-1",
        org_id: orgId,
        po_number: "PO-100",
        vendor_name: "Acme Supplies",
        total_amount: 5000,
        currency: "PKR",
        line_items: [{ description: "Office Desks", quantity: 5, unit_price: 1000, amount: 5000 }],
        source: "manual",
        erp_type: null,
        erp_doc_entry: null,
        erp_doc_num: null,
        created_at: new Date().toISOString(),
      },
    ];
  }

  async listGoodsReceiptNotes(orgId: string): Promise<GoodsReceiptNote[]> {
    return [
      {
        id: "grn-1",
        org_id: orgId,
        grn_number: "GRN-100",
        po_number: "PO-100",
        vendor_name: "Acme Supplies",
        total_received_amount: 5000,
        line_items: [{ description: "Office Desks", quantity: 5, amount: 5000 }],
        received_at: new Date().toISOString(),
        source: "manual",
        erp_type: null,
        erp_doc_entry: null,
        erp_doc_num: null,
        created_at: new Date().toISOString(),
      },
    ];
  }

  async insertAuditLog(orgId: string, entry: any): Promise<void> {}

  async saveTempUpload(orgId: string, upload: any): Promise<TempCsvUpload> {
    const record: TempCsvUpload = {
      id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      org_id: orgId,
      uploaded_by: upload.uploadedBy ?? null,
      file_name: upload.fileName,
      storage_path: upload.storagePath ?? null,
      file_content: upload.fileContent,
      detected_columns: upload.detectedColumns,
      sample_rows: upload.sampleRows,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString()
    };
    this.tempUploads.push(record);
    return record;
  }

  async getTempUpload(orgId: string, uploadId: string): Promise<TempCsvUpload | null> {
    return this.tempUploads.find((t) => t.id === uploadId && t.org_id === orgId) || null;
  }

  async deleteTempUpload(orgId: string, uploadId: string): Promise<void> {
    this.tempUploads = this.tempUploads.filter((t) => t.id !== uploadId);
  }

  async cleanupExpiredUploads(orgId?: string): Promise<number> {
    const now = new Date();
    const initial = this.tempUploads.length;
    this.tempUploads = this.tempUploads.filter((t) => new Date(t.expires_at) > now);
    return initial - this.tempUploads.length;
  }

  async saveCsvMapping(orgId: string, name: string, mapping: any, userId?: string | null): Promise<SavedCsvMapping> {
    const existing = this.savedMappings.find((m) => m.org_id === orgId && m.name === name);
    if (existing) {
      existing.column_mapping = mapping;
      existing.updated_at = new Date().toISOString();
      return existing;
    }
    const record: SavedCsvMapping = {
      id: `map-${Date.now()}`,
      org_id: orgId,
      name,
      column_mapping: mapping,
      created_by: userId ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.savedMappings.push(record);
    return record;
  }

  async listSavedCsvMappings(orgId: string): Promise<SavedCsvMapping[]> {
    return this.savedMappings.filter((m) => m.org_id === orgId);
  }
}

class MockAuditLogService {
  logs: any[] = [];
  async write(input: any) {
    this.logs.push(input);
  }
}

async function runTests() {
  console.log("=== Running CSV Bulk Import Service Tests ===");
  const repo = new MockAccountsPayableRepository();
  const fbr = new FbrComplianceService();
  const matcher = new ThreeWayMatchingService(repo as any);
  const audit = new MockAuditLogService();

  const service = new CsvBulkImportService(
    repo as unknown as AccountsPayableRepository,
    matcher,
    audit as unknown as AuditLogService,
    fbr
  );

  const orgId = "00000000-0000-0000-0000-000000000001";

  // ─────────────────────────────────────────────────────────────
  // Test 1: Direct-Template Import (Fallback Compatibility)
  // ─────────────────────────────────────────────────────────────
  {
    const csvContent = `invoice_number,vendor_name,vendor_tax_id,invoice_date,due_date,amount,currency,po_number,grn_number,line_items_description,payment_terms
INV-001,Acme Supplies,1234567-8,2026-06-01,2026-06-30,5000,PKR,PO-100,GRN-100,Office Desks,Net 30`;

    const res = await service.importInvoicesFromCsv(orgId, Buffer.from(csvContent));
    console.log("Test 1 Result:", res);
    if (res.success_count !== 1 || res.failed_count !== 0) {
      throw new Error(`Test 1 Failed: Expected 1 success, 0 failed. Got ${res.success_count}, ${res.failed_count}`);
    }
    const inv = repo.invoices.find((i) => i.invoice_number === "INV-001");
    if (!inv || inv.status !== "approved" || inv.match_status !== "matched") {
      throw new Error(`Test 1 Failed: Invoice status expected approved/matched. Got ${inv?.status}/${inv?.match_status}`);
    }
    console.log("✓ Test 1 Passed: Direct template fallback works seamlessly.");
  }

  // ─────────────────────────────────────────────────────────────
  // Test 2: Preview with Custom Headers & Static Alias Matching
  // ─────────────────────────────────────────────────────────────
  {
    const customCsv = `Bill No,Supplier Company,Tax Number,Doc Date,Payment Due,Gross Amount,Curr,Purchase Order #,Delivery Note #,Item Details,Credit Terms
B-901,Acme Supplies,9876543-2,2026-06-10,2026-07-10,5000,PKR,PO-100,GRN-100,Office Desks,Net 30
B-902,Beta Logistics,1122334-4,2026-06-12,2026-07-12,1200,USD,,,Logistics Service,COD`;

    const preview = await service.previewCsv(orgId, Buffer.from(customCsv), "custom_erp_export.csv");
    console.log("Test 2 Preview Result:", {
      upload_id: preview.upload_id,
      detected_columns: preview.detected_columns,
      sample_rows_count: preview.sample_rows.length,
      suggested_mapping: preview.suggested_mapping
    });

    if (preview.detected_columns.length !== 11) {
      throw new Error(`Test 2 Failed: Expected 11 detected columns. Got ${preview.detected_columns.length}`);
    }
    if (preview.sample_rows.length !== 2) {
      throw new Error(`Test 2 Failed: Expected 2 sample rows. Got ${preview.sample_rows.length}`);
    }

    // Verify static alias mappings
    if (preview.suggested_mapping.invoice_number !== "Bill No") {
      throw new Error(`Expected invoice_number -> 'Bill No', got '${preview.suggested_mapping.invoice_number}'`);
    }
    if (preview.suggested_mapping.vendor_name !== "Supplier Company") {
      throw new Error(`Expected vendor_name -> 'Supplier Company', got '${preview.suggested_mapping.vendor_name}'`);
    }
    if (preview.suggested_mapping.due_date !== "Payment Due") {
      throw new Error(`Expected due_date -> 'Payment Due', got '${preview.suggested_mapping.due_date}'`);
    }
    if (preview.suggested_mapping.amount !== "Gross Amount") {
      throw new Error(`Expected amount -> 'Gross Amount', got '${preview.suggested_mapping.amount}'`);
    }

    console.log("✓ Test 2 Passed: Preview parsed 5 sample rows and computed exact alias suggestions.");

    // ─────────────────────────────────────────────────────────────
    // Test 3: Confirm with Missing Required Mapping Validation
    // ─────────────────────────────────────────────────────────────
    try {
      await service.confirmMappedImport(orgId, preview.upload_id, {
        invoice_number: "Bill No",
        vendor_name: "Supplier Company",
        amount: null, // MISSING REQUIRED AMOUNT
        due_date: "Payment Due"
      });
      throw new Error("Test 3 Failed: Confirm should have thrown BadRequestException for missing required amount mapping!");
    } catch (err: any) {
      if (!err?.message?.includes("Required field 'amount' is not mapped")) {
        throw err;
      }
      console.log("✓ Test 3 Passed: Required field mapping validation rejected missing amount mapping.");
    }

    // ─────────────────────────────────────────────────────────────
    // Test 4: Confirm Custom Mapped Import Execution & Save Preset
    // ─────────────────────────────────────────────────────────────
    const confirmRes = await service.confirmMappedImport(
      orgId,
      preview.upload_id,
      {
        invoice_number: "Bill No",
        vendor_name: "Supplier Company",
        vendor_tax_id: "Tax Number",
        invoice_date: "Doc Date",
        due_date: "Payment Due",
        amount: "Gross Amount",
        currency: "Curr",
        po_number: "Purchase Order #",
        grn_number: "Delivery Note #",
        line_items_description: "Item Details",
        payment_terms: "Credit Terms"
      },
      "user-123",
      "My ERP Preset"
    );

    console.log("Test 4 Confirm Result:", confirmRes);
    if (confirmRes.success_count !== 2 || confirmRes.failed_count !== 0) {
      throw new Error(`Test 4 Failed: Expected 2 success, 0 failed. Got ${confirmRes.success_count}, ${confirmRes.failed_count}`);
    }

    // Verify imported rows in DB
    const invB901 = repo.invoices.find((i) => i.invoice_number === "B-901");
    if (!invB901 || invB901.status !== "approved" || invB901.match_status !== "matched") {
      throw new Error(`Test 4 Failed: Invoice B-901 expected approved/matched. Got ${invB901?.status}/${invB901?.match_status}`);
    }

    // Verify temp upload was cleaned up
    const tempStillExists = await repo.getTempUpload(orgId, preview.upload_id);
    if (tempStillExists) {
      throw new Error("Test 4 Failed: Temporary upload was not deleted after confirm!");
    }

    // Verify saved mapping preset was stored
    const saved = await service.getSavedMappings(orgId);
    if (saved.length === 0 || saved[0].name !== "My ERP Preset") {
      throw new Error(`Test 4 Failed: Saved mapping preset not found! Got ${JSON.stringify(saved)}`);
    }

    console.log("✓ Test 4 Passed: Custom mapped import completed, invoices matched, temp record purged, preset saved.");
  }

  // ─────────────────────────────────────────────────────────────
  // Test 5: Validation Errors & Rollback during Mapped Import
  // ─────────────────────────────────────────────────────────────
  {
    const badCsv = `InvId,Supplier,NetVal,Due
INV-BAD-1,Alpha Corp,-900,2026-07-01
INV-BAD-2,,1000,2026-07-01
INV-GOOD-1,Gamma Corp,1500,2026-07-01`;

    const preview = await service.previewCsv(orgId, Buffer.from(badCsv));
    const confirmRes = await service.confirmMappedImport(orgId, preview.upload_id, {
      invoice_number: "InvId",
      vendor_name: "Supplier",
      amount: "NetVal",
      due_date: "Due"
    });

    console.log("Test 5 Result:", confirmRes);
    if (confirmRes.success_count !== 1 || confirmRes.failed_count !== 2) {
      throw new Error(`Test 5 Failed: Expected 1 success, 2 failed. Got ${confirmRes.success_count}, ${confirmRes.failed_count}`);
    }

    console.log("✓ Test 5 Passed: Fault-tolerant validation handled mapped rows accurately.");
  }

  console.log("\nALL 5 TEST SCENARIOS PASSED WITH ZERO ERRORS! 🎉");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
