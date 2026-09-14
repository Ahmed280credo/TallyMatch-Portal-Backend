import { Injectable, Logger } from "@nestjs/common";
import type { FieldSpec } from "./column-mapping.config.js";

export interface SkippedRow {
  row_index: number;
  reason: string;
  data: Record<string, string>;
}

export interface TransformResult {
  rows: Record<string, unknown>[];
  skipped: SkippedRow[];
}

export class MissingColumnsError extends Error {
  constructor(public readonly details: { field: string; acceptedHeaders: string[] }[]) {
    const summary = details
      .map((d) => `"${d.field}" (accepted: ${d.acceptedHeaders.join(", ")})`)
      .join("; ");
    super(`CSV is missing required column(s): ${summary}`);
  }
}

const NUMERIC_FIELDS = ["total_amount", "quantity", "unit_price", "quantity_received", "total_received_amount"];

/**
 * Parses a numeric CSV value that may carry a currency code/symbol,
 * thousands separators, or surrounding whitespace (e.g. "PKR 528,000",
 * "Rs. 5,000.50", "$1,200") into a plain number.
 */
function parseAmount(raw: string): number | null {
  // Grab the first numeric token in the string rather than stripping non-numeric
  // characters in place — a currency abbreviation ending in "." (e.g. "Rs. 5,000.50")
  // would otherwise leave its trailing dot attached to the front of the number and
  // corrupt the value (parseFloat(".5000.50") === 0.5) instead of failing loudly.
  const match = raw.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  const cleaned = match[0].replace(/,/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Matches actual CSV headers against each field's accepted alias list
 * (case/whitespace/punctuation-insensitive) and returns the resolved
 * externalHeader -> internalField mapping. Throws MissingColumnsError
 * if any required field has no matching header in the file.
 */
export function resolveColumnMapping(
  actualHeaders: string[],
  fields: FieldSpec[]
): Record<string, string> {
  const normalizedToActual = new Map<string, string>();
  for (const h of actualHeaders) normalizedToActual.set(normalizeHeader(h), h);

  const mapping: Record<string, string> = {};
  const missing: { field: string; acceptedHeaders: string[] }[] = [];

  for (const spec of fields) {
    const matchedHeader = spec.aliases
      .map(normalizeHeader)
      .map((alias) => normalizedToActual.get(alias))
      .find((h) => h !== undefined);

    if (matchedHeader) {
      mapping[matchedHeader] = spec.field;
    } else if (spec.required) {
      missing.push({ field: spec.field, acceptedHeaders: spec.aliases });
    }
  }

  if (missing.length > 0) throw new MissingColumnsError(missing);

  return mapping;
}

@Injectable()
export class CsvTransformerService {
  private readonly logger = new Logger(CsvTransformerService.name);

  transform(rawRows: Record<string, string>[], fields: FieldSpec[]): TransformResult {
    const rows: Record<string, unknown>[] = [];
    const skipped: SkippedRow[] = [];

    if (rawRows.length === 0) return { rows, skipped };

    const mapping = resolveColumnMapping(Object.keys(rawRows[0]), fields);
    const requiredFields = fields.filter((f) => f.required).map((f) => f.field);

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const mapped: Record<string, unknown> = {};

      for (const [externalKey, internalKey] of Object.entries(mapping)) {
        const raw_value = raw[externalKey]?.trim() ?? "";
        mapped[internalKey] = raw_value === "" ? null : raw_value;
      }

      for (const field of NUMERIC_FIELDS) {
        if (mapped[field] !== null && mapped[field] !== undefined) {
          mapped[field] = parseAmount(mapped[field] as string);
        }
      }

      const missing = requiredFields.filter((f) => mapped[f] === null || mapped[f] === undefined);
      if (missing.length > 0) {
        const reason = `Missing required fields: ${missing.join(", ")}`;
        this.logger.warn(`Row ${i + 2} skipped — ${reason}`);
        skipped.push({ row_index: i + 2, reason, data: raw });
        continue;
      }

      rows.push(mapped);
    }

    return { rows, skipped };
  }
}
