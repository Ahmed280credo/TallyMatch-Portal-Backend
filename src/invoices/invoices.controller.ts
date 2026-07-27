import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  PayloadTooLargeException,
  Post,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import type { Queue } from "bullmq";
import { OrgId } from "../common/decorators/org-id.decorator.js";
import type { ExtractAndMatchJobData } from "./dto/extract-and-match-job.dto.js";
import { EXTRACT_AND_MATCH_JOB, EXTRACT_AND_MATCH_QUEUE } from "./queues/invoice-queue.constants.js";
import { SupabaseAuthGuard } from "../auth/supabase-auth.guard.js";

@Controller("v1/invoices")
export class InvoicesController {
  constructor(
    @InjectQueue(EXTRACT_AND_MATCH_QUEUE)
    private readonly invoiceQueue: Queue<ExtractAndMatchJobData>,
    @Inject(ConfigService)
    private readonly config: ConfigService
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
    const maxUploadBytes = this.config.getOrThrow<number>("MAX_UPLOAD_MB") * 1024 * 1024;

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
}

