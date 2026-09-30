import { AccountsPayableRepository } from "./services/accounts-payable.repository.js";
import { AuditLogService } from "./services/audit-log.service.js";
import { CsvBulkImportService } from "./services/csv-bulk-import.service.js";
import { ErpPushService } from "./services/erp-push.service.js";
import { FbrComplianceService } from "./services/fbr-compliance.service.js";
import { GeminiExtractionService } from "./services/gemini-extraction.service.js";
import { PaymentQueueService } from "./services/payment-queue.service.js";
import { PdfTextService } from "./services/pdf-text.service.js";
import { ThreeWayMatchingService } from "./services/three-way-matching.service.js";
import { PdfPageSplitService } from "./services/bundle/pdf-page-split.service.js";
import { BundleClassificationService } from "./services/bundle/bundle-classification.service.js";
import { BundleRichExtractionService } from "./services/bundle/bundle-rich-extraction.service.js";
import { BundleAssemblyService } from "./services/bundle/bundle-assembly.service.js";

export const invoiceProviders = [
  AccountsPayableRepository,
  AuditLogService,
  CsvBulkImportService,
  ErpPushService,
  FbrComplianceService,
  GeminiExtractionService,
  PaymentQueueService,
  PdfTextService,
  ThreeWayMatchingService,
  // Bundle extraction v2 (Phase 1) — behind the per-org extraction_v2_enabled
  // flag; see extract-and-match.processor.ts.
  PdfPageSplitService,
  BundleClassificationService,
  BundleRichExtractionService,
  BundleAssemblyService
];

