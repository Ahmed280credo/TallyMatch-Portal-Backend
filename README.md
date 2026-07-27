# AP Automation NestJS Backend

Production-shaped NestJS backend for a multi-tenant Accounts Payable automation SaaS.

## Folder structure

```text
src/
  main.ts
  worker.ts
  app.module.ts
  common/decorators/org-id.decorator.ts
  config/env.validation.ts
  database/
    database.module.ts
    supabase.client.ts
  invoices/
    invoices.controller.ts
    invoices.module.ts
    invoice-worker.module.ts
    invoices.providers.ts
    dto/extract-and-match-job.dto.ts
    queues/
      invoice-queue.constants.ts
      extract-and-match.processor.ts
    schemas/invoice-extraction.schema.ts
    services/
      accounts-payable.repository.ts
      audit-log.service.ts
      fbr-compliance.service.ts
      gemini-extraction.service.ts
      pdf-text.service.ts
      three-way-matching.service.ts
    types/database.ts
supabase/schema.sql
```

## Run

```bash
npm install
cp .env.example .env
npm run start:dev
npm run start:worker
```

Upload endpoint:

```text
POST /v1/invoices/upload
Header: x-org-id: <tenant-org-uuid>
Multipart field: document=<invoice.pdf>
Optional field: pdf_text=<already extracted PDF text>
```

The API returns `202 Accepted`; the BullMQ worker performs PDF text extraction, Gemini extraction, duplicate detection, FBR mock validation, 3-way matching, invoice update, and audit logging.
