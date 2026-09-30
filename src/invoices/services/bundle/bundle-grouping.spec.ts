// Manual runnable script — mirrors the convention used elsewhere in this repo
// (no Jest configured). Run with `npx tsx src/invoices/services/bundle/bundle-grouping.spec.ts`.
import { groupBundlePages } from "./bundle-grouping.js";
import type { PageClassificationResult } from "../../schemas/bundle-extraction.schema.js";

function page(page_type: PageClassificationResult["page_type"], document_number: string | null = null, confidence = 0.9): PageClassificationResult {
  return { page_type, document_number, confidence };
}

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}`, detail ?? "");
  }
}

// 1. Simple single-page invoice
{
  const groups = groupBundlePages([page("invoice", "INV-1")]);
  check("1. Single invoice page → one group", groups.length === 1 && groups[0].page_indices.length === 1, groups);
}

// 2. Multi-page invoice: header page + continuation page (no number on page 2)
{
  const groups = groupBundlePages([page("invoice", "INV-1"), page("invoice", null)]);
  check(
    "2. Invoice header + continuation (no number) → one group, both pages",
    groups.length === 1 && groups[0].page_indices.length === 2,
    groups
  );
}

// 3. Real bundle: PO, delivery note, invoice (any order) — three separate documents
{
  const groups = groupBundlePages([page("po", "PO-1"), page("delivery_note", "DN-1"), page("invoice", "INV-1")]);
  check(
    "3. PO + delivery_note + invoice → three groups in order",
    groups.length === 3 &&
      groups[0].document_type === "po" &&
      groups[1].document_type === "delivery_note" &&
      groups[2].document_type === "invoice",
    groups
  );
}

// 4. Two invoices back to back with different numbers — must NOT merge
{
  const groups = groupBundlePages([page("invoice", "INV-1"), page("invoice", "INV-2")]);
  check("4. Two different invoice numbers → two groups", groups.length === 2, groups);
}

// 5. blank and other pages are dropped and don't break continuity
{
  const groups = groupBundlePages([page("invoice", "INV-1"), page("blank"), page("other"), page("invoice", null)]);
  check(
    "5. blank/other pages dropped, invoice continuation still joins across them",
    groups.length === 1 && groups[0].page_indices.length === 2 && groups[0].page_indices[1] === 3,
    groups
  );
}

// 6. Bundle with everything: PO (2 pages, totals on page 2) → delivery note → invoice
{
  const groups = groupBundlePages([
    page("po", "PO-1"),
    page("po", null), // totals-only continuation page
    page("delivery_note", "DN-1"),
    page("invoice", "INV-1")
  ]);
  check(
    "6. PO spanning 2 pages (totals on page 2) groups correctly, rest unaffected",
    groups.length === 3 && groups[0].page_indices.length === 2,
    groups
  );
}

// 7. min_confidence tracks the lowest page in a group
{
  const groups = groupBundlePages([page("invoice", "INV-1", 0.95), page("invoice", null, 0.4)]);
  check("7. Group confidence is the minimum across its pages", groups[0].min_confidence === 0.4, groups);
}

console.log(failures === 0 ? "\nALL BUNDLE GROUPING TEST SCENARIOS PASSED! 🎉" : `\n${failures} SCENARIO(S) FAILED`);
if (failures > 0) process.exitCode = 1;
