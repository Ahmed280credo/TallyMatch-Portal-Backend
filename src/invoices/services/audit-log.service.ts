import { Injectable } from "@nestjs/common";
import { AccountsPayableRepository } from "./accounts-payable.repository.js";
import type { AuditEvent, Json } from "../types/database.js";

export interface AuditLogInput {
  orgId: string;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  vendorName?: string | null;
  event: AuditEvent;
  status: string;
  totalAmount?: number | null;
  notes?: string | null;
  metadata?: Json | null;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly repository: AccountsPayableRepository) {}

  async write(input: AuditLogInput): Promise<void> {
    return this.repository.insertAuditLog(input.orgId, {
      invoice_id: input.invoiceId ?? null,
      invoice_number: input.invoiceNumber ?? null,
      vendor_name: input.vendorName ?? null,
      event: input.event,
      status: input.status,
      total_amount: input.totalAmount ?? null,
      notes: input.notes ?? null,
      metadata: input.metadata ?? null
    });
  }
}

