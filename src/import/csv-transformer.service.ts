import { Injectable, Logger } from "@nestjs/common";
import type { ColumnMapping } from "./column-mapping.config.js";

export interface SkippedRow {
  row_index: number;
  reason: string;
  data: Record<string, string>;
}

export interface TransformResult {
  rows: Record<string, unknown>[];
  skipped: SkippedRow[];
}

const NUMERIC_FIELDS = ["total_amount", "quantity", "unit_price", "quantity_received"];

@Injectable()
export class CsvTransformerService {
  private readonly logger = new Logger(CsvTransformerService.name);

  transform(
    rawRows: Record<string, string>[],
    mapping: ColumnMapping,
    requiredFields: readonly string[]
  ): TransformResult {
    const rows: Record<string, unknown>[] = [];
    const skipped: SkippedRow[] = [];

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const mapped: Record<string, unknown> = {};

      for (const [externalKey, internalKey] of Object.entries(mapping)) {
        const raw_value = raw[externalKey]?.trim() ?? "";
        mapped[internalKey] = raw_value === "" ? null : raw_value;
      }

      const missing = requiredFields.filter((f) => !mapped[f]);
      if (missing.length > 0) {
        const reason = `Missing required fields: ${missing.join(", ")}`;
        this.logger.warn(`Row ${i + 2} skipped — ${reason}`);
        skipped.push({ row_index: i + 2, reason, data: raw });
        continue;
      }

      for (const field of NUMERIC_FIELDS) {
        if (mapped[field] !== null && mapped[field] !== undefined) {
          const n = parseFloat(mapped[field] as string);
          mapped[field] = Number.isFinite(n) ? n : null;
        }
      }

      rows.push(mapped);
    }

    return { rows, skipped };
  }
}
