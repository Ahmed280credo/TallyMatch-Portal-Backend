import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Res,
  UnsupportedMediaTypeException,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import type { Response } from "express";
import type { Queue } from "bullmq";
import type { User } from "@supabase/supabase-js";
import { OrgId } from "../common/decorators/org-id.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import type { ExtractAndMatchJobData } from "./dto/extract-and-match-job.dto.js";
import { EXTRACT_AND_MATCH_JOB, EXTRACT_AND_MATCH_QUEUE } from "./queues/invoice-queue.constants.js";
import { SupabaseAuthGuard } from "../auth/supabase-auth.guard.js";
import {
  CsvBulkImportService,
  type BulkImportResponse,
  type CsvPreviewResponse
} from "./services/csv-bulk-import.service.js";
import {
  PaymentQueueService,
  type CreatePaymentRunDto,
  type MarkPaidDto,
  type PaymentQueueQuery
} from "./services/payment-queue.service.js";

const MAX_CSV_SIZE_MB = 20;
const MAX_PROOF_SIZE_MB = 10;

export interface ConfirmImportDto {
  upload_id: string;
  column_mapping: Record<string, string | null>;
  save_mapping_as?: string;
  uploaded_by_user_id?: string;
}

@Controller(["v1/invoices", "invoices"])
export class InvoicesController {
  constructor(
    @InjectQueue(EXTRACT_AND_MATCH_QUEUE)
    private readonly invoiceQueue: Queue<ExtractAndMatchJobData>,
    @Inject(ConfigService)
    private readonly config: ConfigService,
    private readonly csvBulkImportService: CsvBulkImportService,
    private readonly paymentQueueService: PaymentQueueService
  ) {}

  @Post("upload")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SupabaseAuthGuard)
  @UseInterceptors(
    FileInterceptor("document", {
      storage: memoryStorage(),
      limits: {
        files: 1,
        fileSize: Number(process.env.MAX_UPLOAD_MB ?? 15) * 1024 * 1024
      }
    })
  )
  async uploadInvoice(
    @OrgId() orgId: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body("pdf_text") pdfText?: string,
    @Body("uploaded_by_user_id") uploadedByUserId?: string,
    @Headers("content-length") contentLength?: string
  ) {
    const maxUploadBytes = (this.config.get<number>("MAX_UPLOAD_MB") ?? 15) * 1024 * 1024;

    if (typeof contentLength === "string" && Number(contentLength) > maxUploadBytes + 4096) {
      throw new PayloadTooLargeException("Invoice upload exceeds configured MAX_UPLOAD_MB");
    }

    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    if (!file) {
      throw new BadRequestException("Missing multipart file field: document");
    }

    if (file.mimetype !== "application/pdf") {
      throw new UnsupportedMediaTypeException("Only PDF invoice uploads are supported");
    }

    const job = await this.invoiceQueue.add(EXTRACT_AND_MATCH_JOB, {
      orgId,
      uploadedByUserId,
      sourceFileName: file.originalname,
      mimeType: "application/pdf",
      sizeBytes: file.size,
      documentBase64: file.buffer.toString("base64"),
      pdfText: typeof pdfText === "string" && pdfText.trim() ? pdfText : undefined
    });

    return {
      status: "accepted",
      job_id: job.id,
      queue: EXTRACT_AND_MATCH_QUEUE
    };
  }

  /**
   * Direct template bulk-import (works unchanged for existing fixed-template users).
   */
  @Post("bulk-import")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "file", maxCount: 1 },
        { name: "document", maxCount: 1 },
        { name: "csv", maxCount: 1 }
      ],
      {
        storage: memoryStorage(),
        limits: {
          files: 1,
          fileSize: MAX_CSV_SIZE_MB * 1024 * 1024
        }
      }
    )
  )
  async bulkImportInvoices(
    @OrgId() orgId: string | undefined,
    @UploadedFiles()
    files: {
      file?: Express.Multer.File[];
      document?: Express.Multer.File[];
      csv?: Express.Multer.File[];
    },
    @Body("uploaded_by_user_id") uploadedByUserId?: string,
    @Headers("content-length") contentLength?: string
  ): Promise<BulkImportResponse> {
    const file = this.validateAndExtractCsv(orgId, files, contentLength);

    return this.csvBulkImportService.importInvoicesFromCsv(
      orgId!,
      file.buffer,
      file.originalname,
      uploadedByUserId
    );
  }

  /**
   * Preview CSV endpoint: parses header + 5 sample rows, computes suggested mappings,
   * and saves temporary upload record.
   */
  @Post("bulk-import/preview")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "file", maxCount: 1 },
        { name: "document", maxCount: 1 },
        { name: "csv", maxCount: 1 }
      ],
      {
        storage: memoryStorage(),
        limits: {
          files: 1,
          fileSize: MAX_CSV_SIZE_MB * 1024 * 1024
        }
      }
    )
  )
  async previewBulkImport(
    @OrgId() orgId: string | undefined,
    @UploadedFiles()
    files: {
      file?: Express.Multer.File[];
      document?: Express.Multer.File[];
      csv?: Express.Multer.File[];
    },
    @Body("uploaded_by_user_id") uploadedByUserId?: string,
    @Headers("content-length") contentLength?: string
  ): Promise<CsvPreviewResponse> {
    const file = this.validateAndExtractCsv(orgId, files, contentLength);

    return this.csvBulkImportService.previewCsv(
      orgId!,
      file.buffer,
      file.originalname,
      uploadedByUserId
    );
  }

  /**
   * Confirm CSV import: applies user mapping to stored upload and executes pipeline.
   */
  @Post("bulk-import/confirm")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  async confirmBulkImport(
    @OrgId() orgId: string | undefined,
    @Body() dto: ConfirmImportDto
  ): Promise<BulkImportResponse> {
    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    if (!dto || !dto.upload_id || !dto.upload_id.trim()) {
      throw new BadRequestException("Missing required field: upload_id");
    }

    if (!dto.column_mapping || typeof dto.column_mapping !== "object") {
      throw new BadRequestException("Missing or invalid field: column_mapping");
    }

    return this.csvBulkImportService.confirmMappedImport(
      orgId,
      dto.upload_id,
      dto.column_mapping,
      dto.uploaded_by_user_id,
      dto.save_mapping_as
    );
  }

  /**
   * List saved column mapping presets for organization.
   */
  @Get("bulk-import/saved-mappings")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  async getSavedMappings(@OrgId() orgId: string | undefined) {
    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    return this.csvBulkImportService.getSavedMappings(orgId);
  }

  /**
   * Payment queue: invoices sitting at status "queued_for_payment".
   */
  @Get("payment-queue")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  async getPaymentQueue(@OrgId() orgId: string | undefined, @Query() query: PaymentQueueQuery) {
    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    return this.paymentQueueService.getQueue(orgId, query);
  }

  /**
   * Create a payment run from selected invoice_ids or a due_date filter.
   * Moves the selected invoices to "payment_processing" and returns a CSV
   * export (as inline text — the frontend wraps it in a Blob to download).
   */
  @Post("payment-run")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SupabaseAuthGuard)
  async createPaymentRun(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: User | undefined,
    @Body() dto: CreatePaymentRunDto
  ) {
    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    return this.paymentQueueService.createPaymentRun(orgId, user?.id, dto ?? {});
  }

  /**
   * Mark a single invoice as paid: requires proof_of_payment file plus
   * transaction_reference, payment_date, amount_paid. Only allowed while
   * the invoice is in "payment_processing" status.
   */
  @Post(":id/mark-paid")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  @UseInterceptors(
    FileInterceptor("proof_of_payment", {
      storage: memoryStorage(),
      limits: {
        files: 1,
        fileSize: MAX_PROOF_SIZE_MB * 1024 * 1024
      }
    })
  )
  async markInvoicePaid(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: User | undefined,
    @Param("id") invoiceId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: MarkPaidDto,
    @Headers("content-length") contentLength?: string
  ) {
    const maxProofBytes = MAX_PROOF_SIZE_MB * 1024 * 1024;
    if (typeof contentLength === "string" && Number(contentLength) > maxProofBytes + 4096) {
      throw new PayloadTooLargeException(`proof_of_payment exceeds maximum limit of ${MAX_PROOF_SIZE_MB}MB`);
    }

    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    return this.paymentQueueService.markPaid(orgId, invoiceId, user?.id, dto ?? {}, file);
  }

  /**
   * Download the CSV for an existing payment run as an actual file
   * (as opposed to POST /payment-run, which returns the same CSV inline
   * as a JSON string field at creation time).
   */
  @Get("payment-runs/:id/csv")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  async downloadPaymentRunCsv(
    @OrgId() orgId: string | undefined,
    @Param("id") paymentRunId: string,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    const { fileName, csv } = await this.paymentQueueService.getPaymentRunCsv(orgId, paymentRunId);

    res.set({
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${fileName}"`
    });

    return csv;
  }

  /**
   * Invoices within a single payment run, including each invoice's proof
   * of payment, so the submitted document can be checked against the
   * invoice that was marked paid.
   */
  @Get("payment-runs/:id/invoices")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  async getPaymentRunInvoices(@OrgId() orgId: string | undefined, @Param("id") paymentRunId: string) {
    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    return this.paymentQueueService.getPaymentRunInvoices(orgId, paymentRunId);
  }

  /**
   * Payment run history: past runs with aggregate paid/pending status.
   */
  @Get("payment-runs")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  async getPaymentRuns(
    @OrgId() orgId: string | undefined,
    @Query() query: { page?: string; page_size?: string }
  ) {
    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    return this.paymentQueueService.listPaymentRuns(orgId, query);
  }

  private validateAndExtractCsv(
    orgId: string | undefined,
    files: {
      file?: Express.Multer.File[];
      document?: Express.Multer.File[];
      csv?: Express.Multer.File[];
    },
    contentLength?: string
  ): Express.Multer.File {
    const maxUploadBytes = MAX_CSV_SIZE_MB * 1024 * 1024;
    if (typeof contentLength === "string" && Number(contentLength) > maxUploadBytes + 4096) {
      throw new PayloadTooLargeException(`CSV file exceeds maximum limit of ${MAX_CSV_SIZE_MB}MB`);
    }

    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }

    const file = files?.file?.[0] || files?.document?.[0] || files?.csv?.[0];
    if (!file) {
      throw new BadRequestException("Missing CSV file. Provide file in multipart field 'file', 'document', or 'csv'");
    }

    const fileNameLower = file.originalname.toLowerCase();
    const validMimeTypes = [
      "text/csv",
      "application/vnd.ms-excel",
      "text/plain",
      "application/csv",
      "text/comma-separated-values",
      "application/octet-stream"
    ];

    if (!fileNameLower.endsWith(".csv") && !validMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException("Only CSV (.csv) files are supported for bulk invoice import");
    }

    return file;
  }
}
