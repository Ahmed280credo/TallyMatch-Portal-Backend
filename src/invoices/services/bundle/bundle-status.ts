// Pure — merges Phase-1 extraction-time findings with the (unchanged)
// Phase-2 ThreeWayMatchingService's own status/reasons. Status mapping per
// spec: any BLOCK -> mismatch, any REVIEW (no BLOCK) -> pending, INFO
// only/no findings -> approved. The more severe of the two sources wins.
// mismatch_reasons/pending_reasons stay populated from finding messages so
// InvoiceDetailModal (unchanged this phase) keeps working with no frontend
// change required yet.
import type { Finding } from "../../types/database.js";
import type { MatchResult } from "../three-way-matching.service.js";

const STATUS_RANK = { approved: 0, pending: 1, mismatch: 2 } as const;
type Status = keyof typeof STATUS_RANK;

export function severityToStatus(findings: Finding[]): Status {
  if (findings.some((f) => f.severity === "BLOCK")) return "mismatch";
  if (findings.some((f) => f.severity === "REVIEW")) return "pending";
  return "approved";
}

export function mergeExtractionFindingsWithMatchResult(
  findings: Finding[],
  matchResult: MatchResult
): { status: Status; mismatch_reasons: string[]; pending_reasons: string[] } {
  const extractionStatus = severityToStatus(findings);
  const finalStatus = STATUS_RANK[extractionStatus] >= STATUS_RANK[matchResult.status] ? extractionStatus : matchResult.status;

  return {
    status: finalStatus,
    mismatch_reasons: [...matchResult.mismatch_reasons, ...findings.filter((f) => f.severity === "BLOCK").map((f) => f.message)],
    pending_reasons: [...matchResult.pending_reasons, ...findings.filter((f) => f.severity === "REVIEW").map((f) => f.message)]
  };
}
