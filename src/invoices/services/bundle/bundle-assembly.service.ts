import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { EXTRACTION_PROMPT_VERSION } from "../../schemas/bundle-extraction.schema.js";
import { AccountsPayableRepository } from "../accounts-payable.repository.js";
import { AuditLogService } from "../audit-log.service.js";
import { FbrComplianceService } from "../fbr-compliance.service.js";
import { ThreeWayMatchingService } from "../three-way-matching.service.js";
import { ErpConnectionsService } from "../../../erp-connections/erp-connections.service.js";
import { PdfPageSplitService } from "./pdf-page-split.service.js";
import { BundleClassificationService } from "./bundle-classification.service.js";
import { BundleRichExtractionService, type ExtractedDocument } from "./bundle-rich-extraction.service.js";
import { groupBundlePages, type DocumentGroup } from "./bundle-grouping.js";
import { resolveInvoiceDocument, resolvePoDocument, resolveGrnDocument } from "./bundle-document-resolvers.js";
import { decidePoPrecedence, decideGrnPrecedence } from "./bundle-precedence.js";
import { mergeExtractionFindingsWithMatchResult } from "./bundle-status.js";
import type { Finding, Invoice } from "../../types/database.js";
import type { ExtractedInvoice } from "../../schemas/invoice-extraction.schema.js";

export interface BundleProcessingResult {
  bundle_id: string;
  invoices: Array<{ id: string; status: string }>;
  reused_cache: boolean;
}

// Orchestrates the whole Phase-1 bundle pipeline: hash/cache, split, classify,
// group, rich-extract, resolve, apply PO/GRN precedence, create invoice
// row(s), run the existing (unchanged) ThreeWayMatchingService on top, merge
// status. This is the only place Phase 1's new pieces meet the existing
// pipeline — extract-and-match.processor.ts just branches here when the
// org's extraction_v2_enabled flag is set; everything else about the
// existing single-PDF flow is untouched.
@Injectable()
export class BundleAssemblyService {
  private readonly logger = new Logger(BundleAssemblyService.name);

  constructor(
    private readonly repository: AccountsPayableRepository,
    private readonly pageSplit: PdfPageSplitService,
    private readonly classification: BundleClassificationService,
    private readonly richExtraction: BundleRichExtractionService,
    private readonly matcher: ThreeWayMatchingService,
    private readonly audit: AuditLogService,
    private readonly fbrCompliance: FbrComplianceService,
    private readonly erpConnections: ErpConnectionsService
  ) {}

  async processBundle(
    orgId: string,
    sourceFileName: string,
    pdfBuffer: Buffer,
    uploadedByUserId: string | undefined
  ): Promise<BundleProcessingResult> {
    const fileHash = createHash("sha256").update(pdfBuffer).digest("hex");

    const existingBundle = await this.repository.findBundleByFileHash(orgId, fileHash);
    if (existingBundle) {
      // An exact re-upload (identical bytes) is treated as already processed
      // rather than a fresh submission — return the invoices already created
      // from it instead of re-spending Gemini calls or creating duplicates.
      this.logger.log(`Bundle with hash ${fileHash} already processed for org ${orgId} (bundle ${existingBundle.id}) — reusing, no Gemini spend`);
      const priorInvoices = await this.repository.listInvoicesByBundle(orgId, existingBundle.id);
      return {
        bundle_id: existingBundle.id,
        invoices: priorInvoices.map((i) => ({ id: i.id, status: i.status })),
        reused_cache: true
      };
    }

    const erpStatus = await this.erpConnections.getStatus(orgId);
    const extractionMode: "erp" | "paper_only" = erpStatus.configured && erpStatus.status === "connected" ? "erp" : "paper_only";

    const pageCount = await this.pageSplit.getPageCount(pdfBuffer);
    const pages = await this.pageSplit.splitPages(pdfBuffer);
    const classifications = await this.classification.classifyPages(pages);
    const groups = groupBundlePages(classifications);

    const extractedDocs = await this.richExtraction.extractAllGroups(pdfBuffer, groups);

    const bundle = await this.repository.createBundle(orgId, {
      source_file_name: sourceFileName,
      file_hash: fileHash,
      page_count: pageCount,
      page_classification: classifications.map((c, i) => ({ page_index: i, ...c })),
      extraction_mode: extractionMode,
      prompt_version: EXTRACTION_PROMPT_VERSION,
      model_name: null,
      raw_gemini_response: null
    });

    // ── PO / GRN evidence first, so invoice matching below can find them ────
    for (const doc of extractedDocs.filter((d) => d.kind === "po")) {
      await this.writePoEvidence(orgId, bundle.id, doc);
    }
    for (const doc of extractedDocs.filter((d) => d.kind === "grn")) {
      await this.writeGrnEvidence(orgId, bundle.id, doc);
    }

    // ── One invoice per invoice document, sequentially (safe against a rare
    //    same-bundle same-vendor-and-number edge case; bundles are small) ───
    const invoiceDocs = extractedDocs.filter((d) => d.kind === "invoice");
    const results: Array<{ id: string; status: string }> = [];

    for (const doc of invoiceDocs) {
      const invoice = await this.processInvoiceDocument(orgId, bundle.id, doc, sourceFileName, uploadedByUserId);
      if (invoice) results.push({ id: invoice.id, status: invoice.status });
    }

    return { bundle_id: bundle.id, invoices: results, reused_cache: false };
  }

  private async writePoEvidence(orgId: string, bundleId: string, doc: Extract<ExtractedDocument, { kind: "po" }>): Promise<void> {
    const resolved = resolvePoDocument(doc.data);
    if (!resolved.po_number) return; // nothing identifiable to write

    const existing = await this.repository.getPurchaseOrderByNumber(orgId, resolved.po_number);
    const decision = decidePoPrecedence(existing, { po_number: resolved.po_number, total_amount: resolved.total_amount });

    if (decision.action === "skip") {
      this.logger.log(`Skipping bundle PO ${resolved.po_number} — higher-trust ${existing?.source} row already exists`);
      // Evidence + any EVIDENCE_MISMATCH finding is preserved on whichever
      // invoice references this PO, via that invoice's own extraction_metadata
      // (attached in processInvoiceDocument by matching po_number).
      this.pendingPoEvidenceFindings.set(resolved.po_number, decision.findings);
      return;
    }

    await this.repository.upsertBundlePurchaseOrder(orgId, {
      po_number: resolved.po_number,
      vendor_name: resolved.vendor_name,
      total_amount: resolved.total_amount,
      currency: null,
      line_items: resolved.line_items,
      bundle_id: bundleId,
      invoice_id: null
    });
  }

  private async writeGrnEvidence(orgId: string, bundleId: string, doc: Extract<ExtractedDocument, { kind: "grn" }>): Promise<void> {
    const resolved = resolveGrnDocument(doc.data);
    if (!resolved.grn_number) return; // GRN number is often blank on paper — nothing to key an upsert on

    const existing = await this.repository.getGoodsReceiptNoteByNumber(orgId, resolved.grn_number);
    const decision = decideGrnPrecedence(existing, {
      grn_number: resolved.grn_number,
      total_received_amount: null
    });

    if (decision.action === "skip") {
      this.logger.log(`Skipping bundle GRN ${resolved.grn_number} — higher-trust ${existing?.source} row already exists`);
      if (resolved.po_number) this.pendingPoEvidenceFindings.set(`grn:${resolved.grn_number}`, decision.findings);
      return;
    }

    await this.repository.upsertBundleGoodsReceiptNote(orgId, {
      grn_number: resolved.grn_number,
      po_number: resolved.po_number,
      vendor_name: resolved.vendor_name,
      total_received_amount: null,
      line_items: resolved.line_items,
      received_at: resolved.received_at,
      bundle_id: bundleId,
      invoice_id: null
    });
  }

  // po_number -> EVIDENCE_MISMATCH findings raised while writing PO/GRN
  // evidence, carried forward to whichever invoice in this bundle references
  // that po_number. Reset per processBundle call (one bundle at a time; this
  // service isn't request-scoped so state must not leak across bundles).
  private pendingPoEvidenceFindings = new Map<string, Finding[]>();

  private async processInvoiceDocument(
    orgId: string,
    bundleId: string,
    doc: Extract<ExtractedDocument, { kind: "invoice" }>,
    sourceFileName: string,
    uploadedByUserId: string | undefined
  ): Promise<Invoice | null> {
    const resolved = resolveInvoiceDocument(doc.data, doc.pdfText);

    if (!resolved.invoice_number || !resolved.vendor_name) {
      this.logger.warn(`Skipping invoice document in bundle ${bundleId} — missing invoice_number or vendor_name after resolution`);
      return null;
    }

    const duplicate = await this.repository.findInvoiceByNumber(orgId, resolved.invoice_number, resolved.vendor_name);
    if (duplicate) {
      await this.audit.write({
        orgId,
        invoiceId: duplicate.id,
        invoiceNumber: resolved.invoice_number,
        vendorName: resolved.vendor_name,
        event: "DUPLICATE_DETECTED",
        status: "duplicate",
        totalAmount: resolved.total_amount,
        notes: "Invoice number + vendor already exists for this org.",
        metadata: { bundle_id: bundleId, source_file_name: sourceFileName }
      });
      return duplicate;
    }

    const findings = [...resolved.findings];
    if (resolved.po_number) {
      const carried = this.pendingPoEvidenceFindings.get(resolved.po_number);
      if (carried) findings.push(...carried);
    }
    if (resolved.grn_number) {
      const carried = this.pendingPoEvidenceFindings.get(`grn:${resolved.grn_number}`);
      if (carried) findings.push(...carried);
    }

    const fbr = this.fbrCompliance.validateFBRCompliance(resolved.vendor_name, resolved.vendor_ntn);

    const invoice = await this.repository.createInvoice(orgId, {
      vendor_name: resolved.vendor_name,
      vendor_ntn: fbr.ntn,
      invoice_number: resolved.invoice_number,
      po_number: resolved.po_number,
      grn_number: resolved.grn_number,
      invoice_date: resolved.invoice_date,
      due_date: resolved.due_date,
      subtotal: resolved.subtotal,
      tax_amount: resolved.tax_amount,
      total_amount: resolved.total_amount ?? 0,
      currency: resolved.currency,
      payment_terms: resolved.payment_terms,
      line_items: resolved.line_items,
      fbr_status: fbr.status,
      source_file_name: sourceFileName,
      status: "extracted",
      vendor_bank_name: resolved.vendor_bank_name,
      vendor_account_number: resolved.vendor_account_number,
      vendor_iban: resolved.vendor_iban,
      bundle_id: bundleId,
      extraction_metadata: resolved.extraction_metadata,
      findings
    });

    // Reuse the existing, unchanged 3-way matcher — it already reads
    // purchase_orders/goods_receipt_notes regardless of source, so
    // bundle_extracted rows (or a pre-existing higher-trust row the
    // precedence check deferred to) are picked up with no matcher change.
    const matchInput: ExtractedInvoice = {
      vendor_name: resolved.vendor_name,
      vendor_ntn: resolved.vendor_ntn,
      invoice_number: resolved.invoice_number,
      po_number: resolved.po_number,
      grn_number: resolved.grn_number,
      invoice_date: resolved.invoice_date,
      due_date: resolved.due_date,
      subtotal: resolved.subtotal,
      tax_amount: resolved.tax_amount,
      total_amount: resolved.total_amount ?? 0,
      currency: resolved.currency,
      payment_terms: resolved.payment_terms,
      vendor_bank_name: resolved.vendor_bank_name,
      vendor_account_number: resolved.vendor_account_number,
      vendor_iban: resolved.vendor_iban,
      line_items: resolved.line_items
    };
    const matchResult = await this.matcher.matchInvoice(orgId, matchInput);
    const merged = mergeExtractionFindingsWithMatchResult(findings, matchResult);
    const finalMatchStatus = merged.status === "approved" ? "matched" : merged.status;

    const updated = await this.repository.updateInvoice(orgId, invoice.id, {
      match_status: finalMatchStatus,
      match_result: {
        ...matchResult.match_result,
        mismatch_reasons: merged.mismatch_reasons,
        pending_reasons: merged.pending_reasons
      } as unknown as import("../../types/database.js").Json,
      status: merged.status
    });

    try {
      await this.audit.write({
        orgId,
        invoiceId: updated.id,
        invoiceNumber: resolved.invoice_number,
        vendorName: resolved.vendor_name,
        event: merged.status === "approved" ? "APPROVED" : "MATCH_FAILED",
        status: merged.status,
        totalAmount: resolved.total_amount,
        notes: [...merged.mismatch_reasons, ...merged.pending_reasons].join("; ") || "All checks passed.",
        metadata: {
          bundle_id: bundleId,
          source_file_name: sourceFileName,
          uploaded_by_user_id: uploadedByUserId,
          match_status: finalMatchStatus,
          findings
        } as unknown as import("../../types/database.js").Json
      });
    } catch (auditErr) {
      this.logger.error(`[AUDIT LOG FAILED] ${auditErr instanceof Error ? auditErr.message : JSON.stringify(auditErr)}`);
    }

    return updated;
  }
}
