import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { SUPABASE_CLIENT } from "../../database/supabase.client.js";
import { AccountsPayableRepository, type PaymentQueueFilters } from "./accounts-payable.repository.js";
import { AuditLogService } from "./audit-log.service.js";
import type { Invoice, PaymentRun } from "../types/database.js";

const PROOF_BUCKET = "documents";
const MAX_PROOF_SIZE_MB = 10;
const ALLOWED_PROOF_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp"
]);
const AMOUNT_TOLERANCE = 0.01;

export interface PaymentQueueQuery {
  sort_by?: string;
  sort_dir?: string;
  page?: string;
  page_size?: string;
  vendor_name?: string;
  due_date_from?: string;
  due_date_to?: string;
}

export interface CreatePaymentRunDto {
  invoice_ids?: string[];
  due_date_from?: string;
  due_date_to?: string;
}

export interface MarkPaidDto {
  transaction_reference?: string;
  payment_date?: string;
  amount_paid?: string | number;
}

export interface PaymentRunHistoryEntry extends PaymentRun {
  status: "paid" | "partially_paid" | "pending";
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function csvField(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildPaymentRunCsv(invoices: Invoice[], paymentRunId: string): string {
  const columns = [
    "invoice_number",
    "vendor_name",
    "vendor_bank_name",
    "vendor_account_number",
    "vendor_iban",
    "amount",
    "currency",
    "due_date",
    "po_number",
    "status",
    "transaction_reference",
    "payment_date",
    "amount_paid",
    "payment_amount_mismatch",
    "proof_of_payment_url",
    "invoice_id",
    "payment_run_id"
  ];

  // Note: transaction_reference / payment_date / amount_paid / proof_of_payment_url
  // are only populated once an invoice has actually been marked paid, so a CSV
  // downloaded right after creating the run (before payment) will show these blank
  // — re-downloading later from Payment Run History reflects the current state.
  const rows = invoices.map((invoice) =>
    [
      invoice.invoice_number,
      invoice.vendor_name,
      invoice.vendor_bank_name,
      invoice.vendor_account_number,
      invoice.vendor_iban,
      invoice.total_amount,
      invoice.currency,
      invoice.due_date,
      invoice.po_number,
      invoice.status,
      invoice.transaction_reference,
      invoice.payment_date,
      invoice.amount_paid,
      invoice.payment_amount_mismatch,
      invoice.proof_of_payment_url,
      invoice.id,
      paymentRunId
    ]
      .map(csvField)
      .join(",")
  );

  return [columns.join(","), ...rows].join("\n");
}

@Injectable()
export class PaymentQueueService {
  constructor(
    private readonly repository: AccountsPayableRepository,
    private readonly audit: AuditLogService,
    @Inject(SUPABASE_CLIENT)
    private readonly supabase: any
  ) {}

  async getQueue(orgId: string, query: PaymentQueueQuery) {
    const sortByRaw = query.sort_by ?? "due_date";
    if (!["due_date", "vendor_name", "amount"].includes(sortByRaw)) {
      throw new BadRequestException("sort_by must be one of: due_date, vendor_name, amount");
    }
    const sortDirRaw = (query.sort_dir ?? "asc").toLowerCase();
    if (!["asc", "desc"].includes(sortDirRaw)) {
      throw new BadRequestException("sort_dir must be one of: asc, desc");
    }

    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.page_size ?? "20", 10) || 20));

    const filters: PaymentQueueFilters = {
      sortBy: sortByRaw as PaymentQueueFilters["sortBy"],
      sortDir: sortDirRaw as PaymentQueueFilters["sortDir"],
      page,
      pageSize,
      vendorName: query.vendor_name?.trim() || undefined,
      dueDateFrom: query.due_date_from?.trim() || undefined,
      dueDateTo: query.due_date_to?.trim() || undefined
    };

    const { rows, total } = await this.repository.listQueuedForPayment(orgId, filters);
    const today = todayIsoDate();

    return {
      invoices: rows.map((invoice) => ({
        ...invoice,
        is_overdue: Boolean(invoice.due_date) && (invoice.due_date as string) < today
      })),
      page,
      page_size: pageSize,
      total
    };
  }

  async createPaymentRun(orgId: string, userId: string | undefined, dto: CreatePaymentRunDto) {
    const hasIds = Array.isArray(dto.invoice_ids) && dto.invoice_ids.length > 0;
    const hasDateFilter = Boolean(dto.due_date_from || dto.due_date_to);

    if (!hasIds && !hasDateFilter) {
      throw new BadRequestException("Provide either invoice_ids or a due_date_from/due_date_to filter");
    }

    let candidates: Invoice[];

    if (hasIds) {
      const invoiceIds = [...new Set(dto.invoice_ids)];
      candidates = await this.repository.getInvoicesByIds(orgId, invoiceIds);

      const foundIds = new Set(candidates.map((invoice) => invoice.id));
      const missing = invoiceIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(`Invoice(s) not found in this organization: ${missing.join(", ")}`);
      }

      const notQueued = candidates.filter((invoice) => invoice.status !== "queued_for_payment");
      if (notQueued.length > 0) {
        throw new BadRequestException(
          `Invoice(s) are not in queued_for_payment status: ${notQueued
            .map((invoice) => `${invoice.invoice_number ?? invoice.id} (${invoice.status})`)
            .join(", ")}`
        );
      }
    } else {
      candidates = await this.repository.listQueuedForPaymentByDueDateRange(
        orgId,
        dto.due_date_from,
        dto.due_date_to
      );
    }

    if (candidates.length === 0) {
      throw new BadRequestException("No invoices matched the payment run selection");
    }

    const totalAmount = candidates.reduce((sum, invoice) => sum + (Number(invoice.total_amount) || 0), 0);

    const paymentRun = await this.repository.createPaymentRun(orgId, {
      created_by: userId ?? null,
      total_amount: Number(totalAmount.toFixed(2)),
      invoice_count: candidates.length
    });

    const linked = await this.repository.linkInvoicesToPaymentRun(
      orgId,
      candidates.map((invoice) => invoice.id),
      paymentRun.id
    );

    return {
      payment_run_id: paymentRun.id,
      invoice_count: linked.length,
      total_amount: paymentRun.total_amount,
      csv: buildPaymentRunCsv(linked, paymentRun.id)
    };
  }

  async markPaid(
    orgId: string,
    invoiceId: string,
    userId: string | undefined,
    dto: MarkPaidDto,
    file: Express.Multer.File | undefined
  ): Promise<Invoice> {
    const invoice = await this.repository.getInvoiceById(orgId, invoiceId);
    if (!invoice) {
      throw new NotFoundException("Invoice not found");
    }
    if (invoice.status !== "payment_processing") {
      throw new BadRequestException(
        `Invoice must be in payment_processing status to mark as paid (current status: ${invoice.status})`
      );
    }

    if (!file) {
      throw new BadRequestException("Missing multipart file field: proof_of_payment");
    }
    if (!ALLOWED_PROOF_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException("proof_of_payment must be a PDF or image (png/jpg/webp)");
    }
    if (file.size > MAX_PROOF_SIZE_MB * 1024 * 1024) {
      throw new BadRequestException(`proof_of_payment exceeds maximum size of ${MAX_PROOF_SIZE_MB}MB`);
    }

    const transactionReference = dto.transaction_reference?.trim();
    if (!transactionReference) {
      throw new BadRequestException("transaction_reference is required");
    }

    const paymentDate = dto.payment_date?.trim();
    if (!paymentDate || Number.isNaN(Date.parse(paymentDate))) {
      throw new BadRequestException("payment_date is required and must be a valid date");
    }

    const amountPaid = Number(dto.amount_paid);
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      throw new BadRequestException("amount_paid is required and must be a positive number");
    }

    const extension = file.originalname.includes(".") ? file.originalname.split(".").pop() : "bin";
    const storagePath = `payment-proofs/${orgId}/${invoiceId}-${randomUUID()}.${extension}`;

    const { error: uploadError } = await this.supabase.storage
      .from(PROOF_BUCKET)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });

    if (uploadError) {
      throw new BadRequestException(`Failed to store proof of payment: ${uploadError.message}`);
    }

    const { data: publicUrlData } = this.supabase.storage.from(PROOF_BUCKET).getPublicUrl(storagePath);
    const proofOfPaymentUrl = publicUrlData?.publicUrl ?? null;

    const invoiceTotal = Number(invoice.total_amount) || 0;
    const paymentAmountMismatch = Math.abs(amountPaid - invoiceTotal) > AMOUNT_TOLERANCE;

    const updated = await this.repository.updateInvoice(orgId, invoiceId, {
      status: "paid",
      proof_of_payment_url: proofOfPaymentUrl,
      transaction_reference: transactionReference,
      payment_date: paymentDate,
      amount_paid: amountPaid,
      payment_amount_mismatch: paymentAmountMismatch
    });

    await this.audit.write({
      orgId,
      invoiceId: updated.id,
      invoiceNumber: updated.invoice_number,
      vendorName: updated.vendor_name,
      event: "PAID",
      status: "paid",
      totalAmount: updated.total_amount,
      notes: paymentAmountMismatch
        ? `Paid by ${userId ?? "unknown user"}. Transaction ref: ${transactionReference}. Amount paid (${amountPaid}) differs from invoice total (${invoiceTotal}) — flagged for review.`
        : `Paid by ${userId ?? "unknown user"}. Transaction ref: ${transactionReference}.`,
      metadata: {
        transaction_reference: transactionReference,
        payment_date: paymentDate,
        amount_paid: amountPaid,
        payment_amount_mismatch: paymentAmountMismatch
      }
    });

    return updated;
  }

  async getPaymentRunCsv(orgId: string, paymentRunId: string): Promise<{ fileName: string; csv: string }> {
    const run = await this.repository.getPaymentRunById(orgId, paymentRunId);
    if (!run) {
      throw new NotFoundException("Payment run not found");
    }

    const invoices = await this.repository.getInvoicesByPaymentRun(orgId, paymentRunId);

    return {
      fileName: `payment-run-${paymentRunId}.csv`,
      csv: buildPaymentRunCsv(invoices, paymentRunId)
    };
  }

  /**
   * Invoices belonging to a single payment run, including each invoice's
   * proof-of-payment document so it can be checked against the invoice
   * that was marked paid.
   */
  async getPaymentRunInvoices(orgId: string, paymentRunId: string) {
    const run = await this.repository.getPaymentRunById(orgId, paymentRunId);
    if (!run) {
      throw new NotFoundException("Payment run not found");
    }

    const invoices = await this.repository.getInvoicesByPaymentRun(orgId, paymentRunId);

    return {
      payment_run_id: run.id,
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        invoice_number: invoice.invoice_number,
        vendor_name: invoice.vendor_name,
        total_amount: invoice.total_amount,
        currency: invoice.currency,
        status: invoice.status,
        transaction_reference: invoice.transaction_reference,
        payment_date: invoice.payment_date,
        amount_paid: invoice.amount_paid,
        payment_amount_mismatch: invoice.payment_amount_mismatch,
        proof_of_payment_url: invoice.proof_of_payment_url
      }))
    };
  }

  async listPaymentRuns(orgId: string, query: { page?: string; page_size?: string }) {
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.page_size ?? "20", 10) || 20));

    const { rows, total } = await this.repository.listPaymentRuns(orgId, page, pageSize);

    const runIds = rows.map((run) => run.id);
    const invoiceStatuses = await this.repository.listInvoiceStatusesForPaymentRuns(orgId, runIds);

    const statusesByRun = new Map<string, string[]>();
    for (const row of invoiceStatuses) {
      const list = statusesByRun.get(row.payment_run_id) ?? [];
      list.push(row.status);
      statusesByRun.set(row.payment_run_id, list);
    }

    const runsWithStatus: PaymentRunHistoryEntry[] = rows.map((run) => {
      const statuses = statusesByRun.get(run.id) ?? [];
      const allPaid = statuses.length > 0 && statuses.every((status) => status === "paid");
      const nonePaid = statuses.every((status) => status !== "paid");

      return {
        ...run,
        status: allPaid ? "paid" : nonePaid ? "pending" : "partially_paid"
      };
    });

    return { payment_runs: runsWithStatus, page, page_size: pageSize, total };
  }
}
