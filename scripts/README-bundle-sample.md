# Running the 5 sample PDFs through the v2 pipeline on staging

Checks extraction quality on real Pakistani FMCG paperwork (Sea Prince
16717, Nestlé 1073578903, Hyatt INV1530289, Sea Prince 17025, Shahbaz 883)
before Phase 2 starts. This is a manual, one-off checklist — not run in CI.

## 1. Apply the migration on staging (if not already)

Run `invoice-hub/supabase/migrations/20260930_bundle_extraction_v2.sql`
against the **staging** Supabase project's SQL Editor. Confirm it's staging,
not production, before running.

## 2. Turn on the flag for a test org

```sql
update organizations set extraction_v2_enabled = true where id = '<org-uuid>';
```

## 3. Get a bearer token + org id

Log into the staging frontend as a user in that org, open devtools →
Application → local storage (or Network tab on any authenticated request)
and copy the Supabase access token. The org id is the same `<org-uuid>`
from step 2.

## 4. Deploy the split commits to staging first

This review round's backend changes are on branch `phase1-review-split`
(not yet on `main` — see the main summary for why). Point staging at that
branch, or merge it, before running the samples, or the flag will have no
code to actually exercise.

## 5. Upload the 5 PDFs

```bash
STAGING_API_URL=https://<your-staging-host>/api/v1 \
STAGING_TOKEN=<bearer token from step 3> \
STAGING_ORG_ID=<org-uuid> \
  ./scripts/run-bundle-sample.sh /path/to/dir/with/the/5/pdfs
```

Rename your local PDF copies to match the filenames the script expects
(`sea-prince-16717.pdf`, `nestle-1073578903.pdf`, `hyatt-inv1530289.pdf`,
`sea-prince-17025.pdf`, `shahbaz-883.pdf`), or edit the `FILES` array in
the script.

Each upload returns `202 Accepted` immediately — it only enqueues the job.
Give the worker 30–60s per bundle (multiple Gemini calls: classification +
one rich-extraction call per document in the bundle).

## 6. Pull extraction_metadata + findings back out

Run against the **staging** Supabase SQL Editor:

```sql
select
  i.id,
  i.invoice_number,
  i.vendor_name,
  i.po_number,
  i.grn_number,
  i.status,
  i.match_status,
  i.findings,
  i.extraction_metadata,
  b.source_file_name,
  b.page_classification
from invoices i
join bundles b on b.id = i.bundle_id
where i.org_id = '<org-uuid>'
order by i.created_at desc
limit 20;
```

Things worth eyeballing per invoice:
- `findings` — any `LOW_CONFIDENCE`, `VISION_TEXT_MISMATCH`, `LINE_MATH_MISMATCH`,
  `DOC_MISMATCH`, `DUPLICATE_ITEM_CODE`, `MISSING_SUPPLIER_TAX_ID`,
  `EVIDENCE_MISMATCH`, or `UNVERIFIED_SOURCE` entries — are they pointing at
  real problems in the source document, or false positives from the
  extraction/resolution logic?
- `extraction_metadata` — per-field `source` (`printed_ocr` /
  `handwritten_ocr` / `stamp` / etc.) and `confidence` — does low confidence
  line up with genuinely hard-to-read handwriting, or is the model
  underconfident on clearly printed text?
- `b.page_classification` — did page grouping correctly split a bundle
  containing more than one invoice, or merge/split incorrectly?
- Cross-check `status`/`match_status` against what you'd expect by eye from
  the source PDFs (PO/GRN found, amounts agree, etc).

## 7. Also check the PO/GRN evidence rows

```sql
select po_number, vendor_name, total_amount, source, bundle_id, invoice_id, is_superseded
from purchase_orders where org_id = '<org-uuid>' order by created_at desc limit 20;

select grn_number, po_number, vendor_name, source, bundle_id, invoice_id, is_superseded
from goods_receipt_notes where org_id = '<org-uuid>' order by created_at desc limit 20;
```

`invoice_id` should be non-null on every row an invoice actually matched
against (the matcher ignores bundle_extracted rows where it's null).
