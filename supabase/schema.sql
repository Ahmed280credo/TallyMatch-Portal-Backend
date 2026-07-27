create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  vendor_name text,
  vendor_ntn text,
  invoice_number text,
  po_number text,
  grn_number text,
  invoice_date date,
  due_date date,
  subtotal numeric(14, 2),
  tax_amount numeric(14, 2),
  total_amount numeric(14, 2),
  currency text,
  payment_terms text,
  line_items jsonb,
  fbr_status text check (fbr_status in ('Active', 'Suspended', 'Unregistered')),
  match_status text check (match_status in ('matched', 'pending_review')),
  match_result jsonb,
  status text not null check (status in ('queued', 'extracted', 'approved', 'pending_review', 'failed')),
  source_file_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists invoices_org_invoice_number_unique
  on invoices (org_id, invoice_number)
  where invoice_number is not null;

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  po_number text not null,
  vendor_name text,
  total_amount numeric(14, 2),
  currency text,
  line_items jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists purchase_orders_org_po_number_unique
  on purchase_orders (org_id, po_number);

create table if not exists goods_receipt_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  grn_number text not null,
  po_number text,
  vendor_name text,
  total_received_amount numeric(14, 2),
  line_items jsonb,
  received_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists goods_receipt_notes_org_grn_number_unique
  on goods_receipt_notes (org_id, grn_number);

create table if not exists invoice_audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  invoice_id uuid references invoices (id),
  invoice_number text,
  vendor_name text,
  event text not null check (event in ('DUPLICATE_DETECTED', 'EXTRACTION_FAILED', 'MATCH_FAILED', 'APPROVED', 'PROCESSED')),
  status text not null,
  total_amount numeric(14, 2),
  notes text,
  metadata jsonb,
  processed_at timestamptz not null default now()
);

alter table invoices enable row level security;
alter table purchase_orders enable row level security;
alter table goods_receipt_notes enable row level security;
alter table invoice_audit_log enable row level security;

create index if not exists invoices_org_id_idx on invoices (org_id);
create index if not exists purchase_orders_org_id_idx on purchase_orders (org_id);
create index if not exists goods_receipt_notes_org_id_idx on goods_receipt_notes (org_id);
create index if not exists invoice_audit_log_org_id_idx on invoice_audit_log (org_id);
