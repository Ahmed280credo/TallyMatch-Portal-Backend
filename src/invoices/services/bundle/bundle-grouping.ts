// Pure page-grouping logic — no I/O, unit-testable without Gemini or a DB.
// Takes the per-page classification results (in page order) and groups pages
// into documents: consecutive pages of the same type sharing a document
// number (or a continuation page with no number of its own) belong to one
// document. "blank" and "other" pages are dropped entirely and don't break
// the continuity of the group on either side of them, since real bundles
// often interleave a letterhead/terms page or a truly blank scan.
import type { PageClassificationResult } from "../../schemas/bundle-extraction.schema.js";
import type { PageType } from "../../types/database.js";

export type GroupableDocumentType = Exclude<PageType, "blank" | "other">;

export interface DocumentGroup {
  document_type: GroupableDocumentType;
  document_number: string | null;
  page_indices: number[];
  // Lowest confidence among the group's pages — a group stitched together
  // from a low-confidence continuation guess should be treated cautiously.
  min_confidence: number;
}

const GROUPABLE_TYPES = new Set<PageType>(["invoice", "cash_memo", "po", "delivery_note", "grn"]);

export function groupBundlePages(classifications: PageClassificationResult[]): DocumentGroup[] {
  const groups: DocumentGroup[] = [];
  let current: DocumentGroup | null = null;

  classifications.forEach((c, pageIndex) => {
    if (!GROUPABLE_TYPES.has(c.page_type)) {
      // blank / other: drop the page, don't touch `current` — a group in
      // progress stays open across it.
      return;
    }

    const type = c.page_type as GroupableDocumentType;
    const sameGroup =
      current &&
      current.document_type === type &&
      (c.document_number == null || current.document_number == null || c.document_number === current.document_number);

    if (sameGroup && current) {
      current.page_indices.push(pageIndex);
      current.document_number = current.document_number ?? c.document_number;
      current.min_confidence = Math.min(current.min_confidence, c.confidence);
      return;
    }

    current = {
      document_type: type,
      document_number: c.document_number,
      page_indices: [pageIndex],
      min_confidence: c.confidence
    };
    groups.push(current);
  });

  return groups;
}
