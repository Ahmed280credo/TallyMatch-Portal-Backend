import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { parse } from "csv-parse";
import { Readable } from "node:stream";
import { AccountsPayableRepository } from "./accounts-payable.repository.js";
import { ThreeWayMatchingService } from "./three-way-matching.service.js";
import { AuditLogService } from "./audit-log.service.js";
import { FbrComplianceService } from "./fbr-compliance.service.js";
import {
  suggestColumnMapping,
  validateRequiredMappings,
  type TargetInvoiceField
} from "../config/csv-column-mapping.config.js";
import type { Invoice, InvoiceLineItem, Json, SavedCsvMapping } from "../types/database.js";

export interface FailedRowReport {
  row_number: number;
  reason: string;
  row_data?: Record<string, string>;
}

export interface BulkImportResponse {
  success_count: number;
  failed_count: number;
  failed_rows: FailedRowReport[];
}

export interface CsvPreviewResponse {
  upload_id: string;
  detected_columns: string[];
  sample_rows: Record<string, string>[];
  suggested_mapping: Record<TargetInvoiceField, string | null>;
}

export const MAX_CSV_IMPORT_ROWS = 5000;
const VALID_CURRENCY_REGEX = /^[A-Z]{3}$/;

function parseAndFormatDate(val?: string | null): { valid: boolean; formatted?: string; error?: string } {
  if (!val || !val.trim()) return { valid: false, error: "Date value is empty" };
  const trimmed = val.trim();

  // Try standard parsing
  let d = new Date(trimmed);

  // If invalid, try DD/MM/YYYY or DD-MM-YYYY formats
  if (isNaN(d.getTime())) {
    const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmyMatch) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10) - 1;
      const year = parseInt(dmyMatch[3], 10);
      d = new Date(year, month, day);
    }
  }

  if (isNaN(d.getTime())) {
    return { valid: false, error: `Invalid date format '${val}'` };
  }

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return { valid: true, formatted: `${yyyy}-${mm}-${dd}` };
}

function parseAmount(val?: string | null): { valid: boolean; amount?: number; error?: string } {
  if (!val || !val.trim()) return { valid: false, error: "Missing required field: amount" };
  const cleaned = val.trim().replace(/,/g, "").replace(/^[^\d.-]+/, "");
  const num = Number(cleaned);
  if (isNaN(num) || !isFinite(num)) {
    return { valid: false, error: `Invalid amount '${val}': must be a valid number` };
  }
  if (num <= 0) {
    return { valid: false, error: `Invalid amount '${val}': must be a positive number greater than zero` };
  }
  return { valid: true, amount: Math.round(num * 100) / 100 };
}

function parseCurrency(val?: string | null): { valid: boolean; currency?: string; error?: string } {
  if (!val || !val.trim()) {
    return { valid: true, currency: "PKR" };
  }
  const curr = val.trim().toUpperCase();
  if (!VALID_CURRENCY_REGEX.test(curr)) {
    return { valid: false, error: `Invalid currency '${val}'. Must be a 3-letter ISO code (e.g. PKR, USD, EUR)` };
  }
  return { valid: true, currency: curr };
}

@Injectable()
export class CsvBulkImportService {
  private readonly logger = new Logger(CsvBulkImportService.name);

  constructor(
    private readonly repository: AccountsPayableRepository,
    private readonly matcher: ThreeWayMatchingService,
    private readonly audit: AuditLogService,
    private readonly fbrCompliance: FbrComplianceService
  ) {}

  /**
   * 1. PREVIEW: Parses only the header row + first 5 data rows.
   * Computes suggested mapping via static alias dictionary and stores file temporarily.
   */
  async previewCsv(
    orgId: string,
    fileBuffer: Buffer,
    fileName: string = "invoices.csv",
    uploadedByUserId?: string
  ): Promise<CsvPreviewResponse> {
    const fileString = fileBuffer.toString("utf-8");
    let detectedColumns: string[] = [];
    const sampleRows: Record<string, string>[] = [];

    const parser = Readable.from(Buffer.from(fileString)).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true
      })
    );

    let rowCount = 0;
    try {
      for await (const record of parser) {
        if (rowCount === 0) {
          detectedColumns = Object.keys(record as Record<string, string>);
        }
        if (rowCount < 5) {
          sampleRows.push(record as Record<string, string>);
        } else {
          parser.destroy();
          break;
        }
        rowCount++;
      }
    } catch (err: any) {
      if (err?.code !== "ERR_STREAM_PREMATURE_CLOSE" && sampleRows.length === 0) {
        throw new BadRequestException(`Failed to parse CSV: ${err instanceof Error ? err.message : "Invalid CSV"}`);
      }
    }

    if (detectedColumns.length === 0) {
      throw new BadRequestException("CSV file appears to be empty or missing header columns");
    }

    const suggestedMapping = suggestColumnMapping(detectedColumns);

    // Save temporary upload record for confirm step (30 min TTL)
    const tempUpload = await this.repository.saveTempUpload(orgId, {
      fileName,
      fileContent: fileString,
      detectedColumns,
      sampleRows,
      uploadedBy: uploadedByUserId ?? null
    });

    // Lazy cleanup of expired uploads in the background
    this.repository.cleanupExpiredUploads(orgId).catch((err) => {
      this.logger.warn(`Failed lazy cleanup of expired uploads: ${err instanceof Error ? err.message : String(err)}`);
    });

    return {
      upload_id: tempUpload.id,
      detected_columns: detectedColumns,
      sample_rows: sampleRows,
      suggested_mapping: suggestedMapping
    };
  }

  /**
   * 2. CONFIRM: Applies user-confirmed column mapping to full stored CSV file,
   * validates rows, and executes matching & audit pipeline.
   */
  async confirmMappedImport(
    orgId: string,
    uploadId: string,
    columnMapping: Record<string, string | null | undefined>,
    uploadedByUserId?: string,
    saveMappingAs?: string
  ): Promise<BulkImportResponse> {
    const tempUpload = await this.repository.getTempUpload(orgId, uploadId);
    if (!tempUpload) {
      throw new NotFoundException(
        "Temporary CSV upload not found or expired. Please upload the CSV file again."
      );
    }

    // Validate that required fields are mapped to valid columns
    const validation = validateRequiredMappings(columnMapping, tempUpload.detected_columns);
    if (!validation.valid) {
      const issues = [
        ...validation.missing.map((f) => `Required field '${f}' is not mapped`),
        ...validation.invalid
      ];
      throw new BadRequestException(`Invalid column mapping: ${issues.join("; ")}`);
    }

    // Optionally save mapping preset for future imports
    if (saveMappingAs && saveMappingAs.trim()) {
      try {
        await this.repository.saveCsvMapping(
          orgId,
          saveMappingAs.trim(),
          columnMapping as Record<string, string | null>,
          uploadedByUserId
        );
      } catch (err) {
        this.logger.warn(`Failed to save mapping preset: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Process full file with mapping
    const result = await this.processCsvStreamWithMapping(
      orgId,
      Buffer.from(tempUpload.file_content, "utf-8"),
      columnMapping,
      tempUpload.file_name,
      uploadedByUserId
    );

    // Delete temp upload after processing
    this.repository.deleteTempUpload(orgId, uploadId).catch((err) => {
      this.logger.warn(`Failed to delete temp upload ${uploadId}: ${err instanceof Error ? err.message : String(err)}`);
    });

    return result;
  }

  /**
   * 3. DIRECT IMPORT FALLBACK: Direct template import path without separate preview/confirm.
   */
  async importInvoicesFromCsv(
    orgId: string,
    fileBuffer: Buffer,
    sourceFileName: string = "bulk_invoices.csv",
    uploadedByUserId?: string
  ): Promise<BulkImportResponse> {
    return this.processCsvStreamWithMapping(
      orgId,
      fileBuffer,
      null, // null mapping triggers automatic standard header / alias resolution
      sourceFileName,
      uploadedByUserId
    );
  }

  /**
   * List saved column mapping presets for the org.
   */
  async getSavedMappings(orgId: string): Promise<SavedCsvMapping[]> {
    return this.repository.listSavedCsvMappings(orgId);
  }

  /**
   * Core streaming processing engine with mapping support, transaction safety,
   * duplicate checking, 3-way matching, and audit logging.
   */
  private async processCsvStreamWithMapping(
    orgId: string,
    fileBuffer: Buffer,
    columnMapping: Record<string, string | null | undefined> | null,
    sourceFileName: string,
    uploadedByUserId?: string
  ): Promise<BulkImportResponse> {
    const failedRows: FailedRowReport[] = [];
    let successCount = 0;
    const seenInvoiceNumbersInBatch = new Set<string>();

    const parser = Readable.from(fileBuffer).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true
      })
    );

    let rowNumber = 1; // Header row is 1, first data row is 2

    // Helper to resolve field value from row given explicit mapping or standard fallback
    const extractFieldValue = (
      row: Record<string, string>,
      targetField: TargetInvoiceField,
      fallbackKeys: string[]
    ): string => {
      if (columnMapping) {
        const mappedCol = columnMapping[targetField];
        if (mappedCol && row[mappedCol] !== undefined) {
          return String(row[mappedCol] ?? "").trim();
        }
        return "";
      }

      // Default fallback: direct key match or normalized search
      for (const k of fallbackKeys) {
        if (row[k] !== undefined) {
          return String(row[k] ?? "").trim();
        }
      }
      return "";
    };

    for await (const rawRecord of parser) {
      rowNumber++;

      if (rowNumber - 1 > MAX_CSV_IMPORT_ROWS) {
        throw new BadRequestException(
          `CSV exceeds maximum limit of ${MAX_CSV_IMPORT_ROWS} rows. Please split into smaller batches.`
        );
      }

      const row = rawRecord as Record<string, string>;

      const invoiceNumber = extractFieldValue(row, "invoice_number", [
        "invoice_number", "invoicenumber", "invoice_no", "invoice_num", "inv_number", "inv no", "invoice #"
      ]);

      const vendorName = extractFieldValue(row, "vendor_name", [
        "vendor_name", "vendorname", "vendor", "supplier_name", "supplier", "company_name"
      ]);

      const vendorTaxId = extractFieldValue(row, "vendor_tax_id", [
        "vendor_tax_id", "vendortaxid", "vendor_ntn", "ntn", "tax_id", "strn"
      ]) || null;

      const rawInvoiceDate = extractFieldValue(row, "invoice_date", [
        "invoice_date", "invoicedate", "inv_date", "date", "bill_date"
      ]);

      const rawDueDate = extractFieldValue(row, "due_date", [
        "due_date", "duedate", "payment_due_date", "expiry_date"
      ]);

      const rawAmount = extractFieldValue(row, "amount", [
        "amount", "total_amount", "total", "net_amount", "invoice_amount", "total_due"
      ]);

      const rawCurrency = extractFieldValue(row, "currency", [
        "currency", "currency_code", "curr", "ccy"
      ]);

      const poNumber = extractFieldValue(row, "po_number", [
        "po_number", "ponumber", "po_no", "purchase_order_number", "po #"
      ]) || null;

      const grnNumber = extractFieldValue(row, "grn_number", [
        "grn_number", "grnnumber", "grn_no", "goods_receipt_number", "grn #"
      ]) || null;

      const lineItemDesc = extractFieldValue(row, "line_items_description", [
        "line_items_description", "line_item_description", "item_description", "description", "item"
      ]) || null;

      const paymentTerms = extractFieldValue(row, "payment_terms", [
        "payment_terms", "paymentterms", "terms", "terms_of_payment"
      ]) || null;

      const vendorBankName = extractFieldValue(row, "vendor_bank_name", [
        "vendor_bank_name", "bank_name", "bank"
      ]) || null;

      const vendorAccountNumber = extractFieldValue(row, "vendor_account_number", [
        "vendor_account_number", "account_number", "account_no"
      ]) || null;

      const vendorIban = extractFieldValue(row, "vendor_iban", [
        "vendor_iban", "iban"
      ]) || null;

      // ── Step 1: Validation Rules ──
      const errors: string[] = [];

      if (!invoiceNumber) {
        errors.push("Missing required field: invoice_number");
      }

      if (!vendorName) {
        errors.push("Missing required field: vendor_name");
      }

      const amountResult = parseAmount(rawAmount);
      if (!amountResult.valid) {
        errors.push(amountResult.error!);
      }

      if (!rawDueDate) {
        errors.push("Missing required field: due_date");
      }

      let formattedDueDate: string | null = null;
      if (rawDueDate) {
        const dueDateResult = parseAndFormatDate(rawDueDate);
        if (!dueDateResult.valid) {
          errors.push(`Invalid due_date: ${dueDateResult.error}`);
        } else {
          formattedDueDate = dueDateResult.formatted!;
        }
      }

      let formattedInvoiceDate: string | null = null;
      if (rawInvoiceDate) {
        const invoiceDateResult = parseAndFormatDate(rawInvoiceDate);
        if (!invoiceDateResult.valid) {
          errors.push(`Invalid invoice_date: ${invoiceDateResult.error}`);
        } else {
          formattedInvoiceDate = invoiceDateResult.formatted!;
        }
      }

      const currencyResult = parseCurrency(rawCurrency);
      if (!currencyResult.valid) {
        errors.push(currencyResult.error!);
      }

      // Intra-batch duplicate check
      if (invoiceNumber) {
        const batchKey = `${invoiceNumber.toLowerCase()}|${vendorName.toLowerCase()}`;
        if (seenInvoiceNumbersInBatch.has(batchKey)) {
          errors.push(`Duplicate invoice_number '${invoiceNumber}' found multiple times in this CSV batch`);
        } else {
          seenInvoiceNumbersInBatch.add(batchKey);
        }
      }

      // Database duplicate check (per org & vendor)
      if (invoiceNumber && errors.length === 0) {
        try {
          const existing = await this.repository.findInvoiceByNumber(orgId, invoiceNumber, vendorName);
          if (existing) {
            errors.push(`Duplicate invoice_number '${invoiceNumber}' already exists in database for this vendor/organization`);
          }
        } catch (dbErr) {
          this.logger.error(`Database lookup error for invoice ${invoiceNumber}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
          errors.push(`Database lookup error: ${dbErr instanceof Error ? dbErr.message : "Unknown error"}`);
        }
      }

      if (errors.length > 0) {
        failedRows.push({
          row_number: rowNumber,
          reason: errors.join(" | "),
          row_data: row
        });
        continue;
      }

      // ── Step 2: Row-level Pipeline with Rollback Safety ──
      const totalAmount = amountResult.amount!;
      const parsedCurrency = currencyResult.currency!;
      let createdInvoice: Invoice | null = null;

      try {
        const fbr = this.fbrCompliance.validateFBRCompliance(vendorName, vendorTaxId);

        const lineItems: InvoiceLineItem[] = lineItemDesc
          ? [
              {
                description: lineItemDesc,
                amount: totalAmount,
                quantity: null,
                unit_price: null
              }
            ]
          : [
              {
                description: "Invoice line item",
                amount: totalAmount,
                quantity: null,
                unit_price: null
              }
            ];

        createdInvoice = await this.repository.createInvoice(orgId, {
          vendor_name: vendorName,
          vendor_ntn: fbr.ntn,
          vendor_tax_id: vendorTaxId,
          invoice_number: invoiceNumber,
          po_number: poNumber,
          grn_number: grnNumber,
          invoice_date: formattedInvoiceDate,
          due_date: formattedDueDate,
          subtotal: totalAmount,
          tax_amount: 0,
          total_amount: totalAmount,
          currency: parsedCurrency,
          payment_terms: paymentTerms,
          line_items: lineItems,
          fbr_status: fbr.status,
          source_file_name: sourceFileName,
          intake_source: "csv_bulk_import",
          status: "extracted",
          vendor_bank_name: vendorBankName,
          vendor_account_number: vendorAccountNumber,
          vendor_iban: vendorIban
        });

        // Run 3-Way Matching Engine directly
        const match = await this.matcher.matchInvoice(orgId, {
          vendor_name: vendorName,
          vendor_ntn: fbr.ntn,
          invoice_number: invoiceNumber,
          po_number: poNumber,
          grn_number: grnNumber,
          invoice_date: formattedInvoiceDate,
          due_date: formattedDueDate,
          subtotal: totalAmount,
          tax_amount: 0,
          total_amount: totalAmount,
          currency: parsedCurrency,
          payment_terms: paymentTerms,
          line_items: lineItems
        });

        const finalStatus = match.status; // "approved" | "mismatch" | "pending"
        const finalMatchStatus = finalStatus === "approved" ? "matched" : finalStatus;
        const allReasons = [...match.pending_reasons, ...match.mismatch_reasons];

        await this.repository.updateInvoice(orgId, createdInvoice.id, {
          match_status: finalMatchStatus,
          match_result: {
            ...match.match_result,
            mismatch_reasons: match.mismatch_reasons,
            pending_reasons: match.pending_reasons
          } as unknown as Json,
          status: finalStatus
        });

        try {
          await this.audit.write({
            orgId,
            invoiceId: createdInvoice.id,
            invoiceNumber,
            vendorName,
            event: finalStatus === "approved" ? "APPROVED" : "MATCH_FAILED",
            status: finalStatus,
            totalAmount,
            notes: allReasons.join("; ") || "All 3-way match checks passed (CSV Bulk Import).",
            metadata: {
              source: "csv_bulk_import",
              source_file_name: sourceFileName,
              uploaded_by_user_id: uploadedByUserId ?? null,
              match_status: finalMatchStatus,
              mismatch_reasons: match.mismatch_reasons,
              pending_reasons: match.pending_reasons
            }
          });
        } catch (auditErr) {
          this.logger.error(`[AUDIT LOG FAILED] ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
        }

        successCount++;
      } catch (pipelineErr) {
        const errorMsg = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
        this.logger.error(`Error processing row ${rowNumber} (invoice: ${invoiceNumber}): ${errorMsg}`);

        // Rollback: delete the created invoice to avoid dirty inconsistent state
        if (createdInvoice?.id) {
          try {
            await this.repository.deleteInvoice(orgId, createdInvoice.id);
            this.logger.log(`Rolled back invoice ${createdInvoice.id} due to mid-processing failure.`);
          } catch (rollbackErr) {
            this.logger.error(`Failed to rollback invoice ${createdInvoice.id}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
          }
        }

        failedRows.push({
          row_number: rowNumber,
          reason: `Pipeline failure during matching/audit: ${errorMsg}`,
          row_data: row
        });
      }
    }

    return {
      success_count: successCount,
      failed_count: failedRows.length,
      failed_rows: failedRows
    };
  }
}
