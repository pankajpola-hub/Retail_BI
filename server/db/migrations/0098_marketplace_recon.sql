-- =============================================================================
-- 0098 · Marketplace Reconciliation — recon_lines + summary views
-- =============================================================================
-- Adds the marketplace reconciliation data model to the ops schema. Additive
-- only: no existing object is touched. Seed data is loaded separately from
-- 0098_marketplace_recon_seed.sql (generated from a Uniware export, PII-free).
--
-- After running: NOTIFY pgrst, 'reload schema';  (so PostgREST sees the views)
-- =============================================================================

create table if not exists ops.recon_lines (
  id                  bigint generated always as identity primary key,
  channel             text        not null,
  order_code          text,
  item_code           text,
  sku                 text,
  status              text,
  order_date          date,
  mrp                 numeric(12,2),
  selling_price       numeric(12,2),
  total_price         numeric(12,2),
  discount            numeric(12,2),
  cgst                numeric(12,2),
  sgst                numeric(12,2),
  igst                numeric(12,2),
  packet_id_present   boolean     not null default false,
  hsn_present         boolean     not null default false,
  invoice_present     boolean     not null default false,
  exception_code      text        not null default 'CLEAN',
  exception_severity  text        not null default 'None',
  exception_amount    numeric(12,2) not null default 0,
  created_at          timestamptz not null default now()
);

create index if not exists idx_recon_channel   on ops.recon_lines (channel);
create index if not exists idx_recon_status     on ops.recon_lines (status);
create index if not exists idx_recon_exception  on ops.recon_lines (exception_code);
create index if not exists idx_recon_date       on ops.recon_lines (order_date);

-- Per-channel rollup the dashboard reads for KPIs + the channel table.
create or replace view ops.recon_channel_summary as
select
  channel,
  count(*)                                          as lines,
  count(distinct order_code)                        as orders,
  coalesce(sum(selling_price),0)                    as net_sales,
  coalesce(sum(discount),0)                         as discount,
  coalesce(sum(coalesce(cgst,0)+coalesce(sgst,0)+coalesce(igst,0)),0) as tax,
  count(*) filter (where status = 'DELIVERED')      as delivered,
  count(*) filter (where status = 'DISPATCHED')     as dispatched,
  count(*) filter (where status = 'CANCELLED')      as cancelled,
  count(*) filter (where exception_code <> 'CLEAN') as exceptions,
  coalesce(sum(exception_amount),0)                 as exposure,
  count(*) filter (where packet_id_present)         as packet_present,
  count(*) filter (where hsn_present)               as hsn_present,
  count(*) filter (where invoice_present)           as invoice_present
from ops.recon_lines
group by channel;

-- Typed exception ledger the dashboard reads for the ledger panel.
create or replace view ops.recon_exception_summary as
select
  exception_code,
  max(exception_severity)           as severity,
  count(*)                          as n,
  coalesce(sum(exception_amount),0) as exposure
from ops.recon_lines
where exception_code <> 'CLEAN'
group by exception_code
order by sum(exception_amount) desc;

-- Match the grant pattern used by ops.erp_report_uploads (0022): read-only for
-- the app role, RLS on. The app reads server-side via the self-hosted client.
alter table ops.recon_lines enable row level security;

create policy recon_lines_read on ops.recon_lines for select
  using (true);

grant select on ops.recon_lines               to authenticated;
grant select on ops.recon_channel_summary     to authenticated;
grant select on ops.recon_exception_summary   to authenticated;
