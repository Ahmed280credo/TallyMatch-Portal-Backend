// Pure — decides whether bundle-extracted PO/GRN evidence should be written
// as a new/refined row, or skipped in favor of an existing higher-trust row.
// No I/O: unit-testable without a DB. Precedence: erp_sync > manual/csv_import
// > bundle_extracted. If a higher-trust row with the same org+po_number (or
// grn_number) already exists, the bundle row is never inserted or upserted
// over it — the extraction is kept only as evidence (extraction_metadata on
// the invoice) and an EVIDENCE_MISMATCH finding is raised if the two
// disagree on amount. A bundle row may still refine an *existing bundle row*
// (same or lower trust), since that's just improving the same evidence, not
// overwriting something more authoritative.
import type { Finding, GoodsReceiptNote, PurchaseOrder, RecordSource } from "../../types/database.js";

const TRUST_RANK: Record<RecordSource, number> = {
  erp_sync: 3,
  manual: 2,
  csv_import: 2,
  bundle_extracted: 1
};

export type PrecedenceDecision = { action: "insert" } | { action: "skip"; findings: Finding[] };

const DEFAULT_AMOUNT_TOLERANCE = 1;

export function decidePoPrecedence(
  existing: PurchaseOrder | null,
  extracted: { po_number: string; total_amount: number | null },
  tolerance = DEFAULT_AMOUNT_TOLERANCE
): PrecedenceDecision {
  if (!existing || TRUST_RANK[existing.source] <= TRUST_RANK.bundle_extracted) {
    return { action: "insert" };
  }

  const findings: Finding[] = [];
  if (extracted.total_amount != null && existing.total_amount != null) {
    const diff = Math.abs(Number(existing.total_amount) - extracted.total_amount);
    if (diff > tolerance) {
      findings.push({
        code: "EVIDENCE_MISMATCH",
        severity: "REVIEW",
        message: `Bundle-extracted PO ${extracted.po_number} total (${extracted.total_amount}) disagrees with the existing ${existing.source} PO on file (${existing.total_amount})`,
        evidence: {
          existing_total: existing.total_amount,
          extracted_total: extracted.total_amount,
          existing_source: existing.source
        }
      });
    }
  }
  return { action: "skip", findings };
}

export function decideGrnPrecedence(
  existing: GoodsReceiptNote | null,
  extracted: { grn_number: string; total_received_amount: number | null },
  tolerance = DEFAULT_AMOUNT_TOLERANCE
): PrecedenceDecision {
  if (!existing || TRUST_RANK[existing.source] <= TRUST_RANK.bundle_extracted) {
    return { action: "insert" };
  }

  const findings: Finding[] = [];
  if (extracted.total_received_amount != null && existing.total_received_amount != null) {
    const diff = Math.abs(Number(existing.total_received_amount) - extracted.total_received_amount);
    if (diff > tolerance) {
      findings.push({
        code: "EVIDENCE_MISMATCH",
        severity: "REVIEW",
        message: `Bundle-extracted GRN ${extracted.grn_number} total (${extracted.total_received_amount}) disagrees with the existing ${existing.source} GRN on file (${existing.total_received_amount})`,
        evidence: {
          existing_total: existing.total_received_amount,
          extracted_total: extracted.total_received_amount,
          existing_source: existing.source
        }
      });
    }
  }
  return { action: "skip", findings };
}
