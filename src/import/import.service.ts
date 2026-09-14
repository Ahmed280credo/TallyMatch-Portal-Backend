import { Inject, Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/supabase.client.js";
import type { SkippedRow } from "./csv-transformer.service.js";

export interface ImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  skipped_rows: SkippedRow[];
}

interface LineItem {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
}

function groupPoRows(rows: Record<string, unknown>[], orgId: string) {
  const map = new Map<string, { base: Record<string, unknown>; items: LineItem[] }>();

  for (const row of rows) {
    const key = row["po_number"] as string;
    if (!map.has(key)) map.set(key, { base: row, items: [] });

    const qty = row["quantity"] as number | null;
    const price = row["unit_price"] as number | null;
    if (row["item_description"] || qty || price) {
      map.get(key)!.items.push({
        description: (row["item_description"] as string) ?? "",
        quantity: qty,
        unit_price: price,
        amount: (qty ?? 0) * (price ?? 0),
      });
    }
  }

  return Array.from(map.values()).map(({ base, items }) => ({
    org_id: orgId,
    po_number: base["po_number"] as string,
    vendor_name: (base["vendor_name"] as string) || null,
    total_amount: base["total_amount"] as number | null,
    currency: "PKR",
    line_items: items.length > 0 ? items : null,
  }));
}

function groupGrnRows(rows: Record<string, unknown>[], orgId: string) {
  const map = new Map<string, { base: Record<string, unknown>; items: LineItem[] }>();

  for (const row of rows) {
    const key = row["grn_number"] as string;
    if (!map.has(key)) map.set(key, { base: row, items: [] });

    const qty = row["quantity_received"] as number | null;
    if (row["item_description"] || qty) {
      map.get(key)!.items.push({
        description: (row["item_description"] as string) ?? "",
        quantity: qty,
        unit_price: null,
        amount: 0,
      });
    }
  }

  return Array.from(map.values()).map(({ base, items }) => {
    const rawDate = base["date"] as string | null;
    let received_at: string | null = null;
    if (rawDate) {
      const d = new Date(rawDate);
      received_at = Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return {
      org_id: orgId,
      grn_number: base["grn_number"] as string,
      po_number: (base["po_number"] as string) || null,
      vendor_name: (base["vendor_name"] as string) || null,
      total_received_amount: (base["total_received_amount"] as number | null) ?? null,
      line_items: items.length > 0 ? items : null,
      received_at,
    };
  });
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient
  ) {}

  async importPurchaseOrders(
    orgId: string,
    rows: Record<string, unknown>[],
    skipped: SkippedRow[]
  ): Promise<ImportResult> {
    const records = groupPoRows(rows, orgId);

    if (records.length > 0) {
      const { error } = await this.supabase
        .from("purchase_orders")
        .upsert(records, { onConflict: "org_id,po_number" });

      if (error) {
        this.logger.error("PO bulk upsert failed", error.message);
        throw new InternalServerErrorException(`Database insert failed: ${error.message}`);
      }
    }

    return { success: true, imported: records.length, skipped: skipped.length, skipped_rows: skipped };
  }

  async importGoodsReceiptNotes(
    orgId: string,
    rows: Record<string, unknown>[],
    skipped: SkippedRow[]
  ): Promise<ImportResult> {
    const records = groupGrnRows(rows, orgId);

    if (records.length > 0) {
      const { error } = await this.supabase
        .from("goods_receipt_notes")
        .upsert(records, { onConflict: "org_id,grn_number" });

      if (error) {
        this.logger.error("GRN bulk upsert failed", error.message);
        throw new InternalServerErrorException(`Database insert failed: ${error.message}`);
      }
    }

    return { success: true, imported: records.length, skipped: skipped.length, skipped_rows: skipped };
  }
}
