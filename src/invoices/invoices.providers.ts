import { AccountsPayableRepository } from "./services/accounts-payable.repository.js";
import { AuditLogService } from "./services/audit-log.service.js";
import { CsvBulkImportService } from "./services/csv-bulk-import.service.js";
import { FbrComplianceService } from "./services/fbr-compliance.service.js";
import { GeminiExtractionService } from "./services/gemini-extraction.service.js";
import { PaymentQueueService } from "./services/payment-queue.service.js";
import { PdfTextService } from "./services/pdf-text.service.js";
import { ThreeWayMatchingService } from "./services/three-way-matching.service.js";

export const invoiceProviders = [
  AccountsPayableRepository,
  AuditLogService,
  CsvBulkImportService,
  FbrComplianceService,
  GeminiExtractionService,
  PaymentQueueService,
  PdfTextService,
  ThreeWayMatchingService
];

