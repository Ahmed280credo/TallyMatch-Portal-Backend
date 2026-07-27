import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { z } from "zod";
import type { ExtractAndMatchJobData } from "../dto/extract-and-match-job.dto.js";
import { AuditLogService } from "../services/audit-log.service.js";
import { FbrComplianceService } from "../services/fbr-compliance.service.js";
import { GeminiExtractionService } from "../services/gemini-extraction.service.js";
import { PdfTextService } from "../services/pdf-text.service.js";
import { AccountsPayableRepository } from "../services/accounts-payable.repository.js";
import { ThreeWayMatchingService } from "../services/three-way-matching.service.js";
import { EXTRACT_AND_MATCH_QUEUE } from "./invoice-queue.constants.js";

const JobSchema = z.object({
  orgId: z.string().min(8),
  uploadedByUserId: z.string().optional(),
  sourceFileName: z.string().min(1),
  mimeType: z.literal("application/pdf"),
  sizeBytes: z.number().int().positive(),
  documentBase64: z.string().min(1),
  pdfText: z.string().optional()
});

@Processor(EXTRACT_AND_MATCH_QUEUE, {
  concurrency: 5
})
export class ExtractAndMatchProcessor extends WorkerHost {
  private readonly logger = new Logger(ExtractAndMatchProcessor.name);

  constructor(
    private readonly repository: AccountsPayableRepository,
    private readonly extractor: GeminiExtractionService,
    private readonly matcher: ThreeWayMatchingService,
    private readonly audit: AuditLogService,
    private readonly fbrCompliance: FbrComplianceService,
    private readonly pdfText: PdfTextService
  ) {
    super();
  }

  async process(job: Job<ExtractAndMatchJobData>) {
    const data = JobSchema.parse(job.data);
    const orgId = data.orgId;

    try {
      const text =
        data.pdfText?.trim() ||
        (await this.pdfText.extractPdfTextFromBuffer(Buffer.from(data.documentBase64, "base64")));

      const extracted = text
        ? await this.extractor.extractFromPdfText(text)
        : await this.extractor.extractFromPdfBase64(data.documentBase64);
      const duplicate = await this.repository.findInvoiceByNumber(orgId, extracted.invoice_number);

      if (duplicate) {
        await this.audit.write({
          orgId,
          invoiceId: duplicate.id,
          invoiceNumber: extracted.invoice_number,
          vendorName: extracted.vendor_name,
          event: "DUPLICATE_DETECTED",
          status: "duplicate",
          totalAmount: extracted.total_amount,
          notes: "Invoice number already exists for this org_id.",
          metadata: { job_id: job.id, source_file_name: data.sourceFileName }
        });

        return { status: "duplicate", invoice_id: duplicate.id };
      }

      const fbr = this.fbrCompliance.validateFBRCompliance(extracted.vendor_name, extracted.vendor_ntn);
      const invoice = await this.repository.createInvoice(orgId, {
        vendor_name: extracted.vendor_name,
        vendor_ntn: fbr.ntn,
        invoice_number: extracted.invoice_number,
        po_number: extracted.po_number ?? null,
        grn_number: extracted.grn_number ?? null,
        invoice_date: extracted.invoice_date,
        due_date: extracted.due_date ?? null,
        subtotal: extracted.subtotal,
        tax_amount: extracted.tax_amount,
        total_amount: extracted.total_amount,
        currency: extracted.currency ?? null,
        payment_terms: extracted.payment_terms ?? null,
        line_items: extracted.line_items,
        fbr_status: fbr.status,
        source_file_name: data.sourceFileName,
        status: "extracted"
      });

      const match = await this.matcher.matchInvoice(orgId, extracted);
      const finalStatus = match.status;
      const finalMatchStatus = finalStatus === "approved" ? "matched" : finalStatus;
      const allReasons = [...match.pending_reasons, ...match.mismatch_reasons];

      await this.repository.updateInvoice(orgId, invoice.id, {
        match_status: finalMatchStatus,
        match_result: {
          ...match.match_result,
          mismatch_reasons: match.mismatch_reasons,
          pending_reasons: match.pending_reasons,
        } as unknown as import("../types/database.js").Json,
        status: finalStatus
      });

      try {
        await this.audit.write({
          orgId,
          invoiceId: invoice.id,
          invoiceNumber: extracted.invoice_number,
          vendorName: extracted.vendor_name,
          event: finalStatus === "approved" ? "APPROVED" : "MATCH_FAILED",
          status: finalStatus,
          totalAmount: extracted.total_amount,
          notes: allReasons.join("; ") || "All 3-way match checks passed.",
          metadata: {
            job_id: job.id,
            source_file_name: data.sourceFileName,
            match_status: finalMatchStatus,
            mismatch_reasons: match.mismatch_reasons,
            pending_reasons: match.pending_reasons,
          }
        });
      } catch (auditErr) {
        this.logger.error(`[AUDIT LOG FAILED] ${auditErr instanceof Error ? auditErr.message : JSON.stringify(auditErr)}`);
      }

      return { status: finalStatus, invoice_id: invoice.id, mismatch_reasons: allReasons };
    } catch (error) {
      this.logger.error("extract_and_match processor failed", error instanceof Error ? error.stack : undefined);

      try {
        await this.audit.write({
          orgId,
          event: "EXTRACTION_FAILED",
          status: "failed",
          notes: error instanceof Error ? error.message : "Unknown extraction or matching failure.",
          metadata: { job_id: job.id, source_file_name: data.sourceFileName }
        });
      } catch (auditErr) {
        this.logger.error(`[AUDIT LOG FAILED] ${auditErr instanceof Error ? auditErr.message : JSON.stringify(auditErr)}`);
      }

      throw error;
    }
  }
}

