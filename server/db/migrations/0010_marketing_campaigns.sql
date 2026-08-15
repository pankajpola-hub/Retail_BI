-- =============================================================================
-- 0010 · DelightChat campaigns, CSV import, recipient-level metrics
-- =============================================================================
-- Grain decision, from the real export: DelightChat gives one row per
-- recipient with no campaign name, store, year, or order data. All four are
-- captured at upload time (the "fill gaps" step in the import mock) and
-- stored on campaign_import_batches / campaigns — never guessed from the file.

create table marketing.campaign_import_batches (
  id              uuid primary key default gen_random_uuid(),
  file_name       text not null,
  uploaded_by     uuid references core.profiles (user_id),
  uploaded_at     timestamptz not null default now(),
  column_mapping  jsonb not null,          -- the saved {csv_column: internal_field} profile used for this import
  row_count       integer not null,
  success_count   integer not null default 0,
  failed_count    integer not null default 0,
  duplicate_count integer not null default 0,
  status          text not null default 'pending' check (status in ('pending', 'committed', 'failed')),
  error_log       jsonb
);

create table marketing.campaigns (
  id                    uuid primary key default gen_random_uuid(),
  external_campaign_id  text,                        -- DelightChat broadcast ID, when available
  campaign_name         text not null,                -- user-supplied at import; the file has no such column
  campaign_date         date not null,                 -- user-supplied; file timestamp has no year
  campaign_type         text,                           -- 'low_footfall' | 'reactivation' | 'promotion' | 'new_collection' | 'store_event' | 'local_marketing' | 'other'
  campaign_status       text not null default 'recommended'
    check (campaign_status in ('recommended','requested','approved','rejected','in_progress','completed','result_measured')),
  requested_by          uuid references core.profiles (user_id),
  approved_by            uuid references core.profiles (user_id),
  template               text,
  offer                   text,
  description              text,
  import_batch_id          uuid references marketing.campaign_import_batches (id),
  created_at                timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- A campaign can target more than one store (the sample broadcast covered both
-- BO-001 and BO-003) — many-to-many, not a single store_id column on campaigns.
create table marketing.campaign_stores (
  campaign_id  uuid not null references marketing.campaigns (id) on delete cascade,
  store_id     text not null references core.stores (store_id),
  primary key (campaign_id, store_id)
);

-- Recipient grain, matching the export exactly. NOT flattened into
-- campaign_metrics at upload — the per-error-code breakdown (screen 07's
-- actual finding: 77% of failures share one Meta error code) only exists at
-- this grain.
create table marketing.campaign_recipients (
  id                      uuid primary key default gen_random_uuid(),
  campaign_id             uuid not null references marketing.campaigns (id) on delete cascade,
  import_batch_id         uuid references marketing.campaign_import_batches (id),
  recipient_phone         text not null,
  recipient_name          text,
  sent_at                 timestamptz,
  attempted               boolean not null default false,
  sent                    boolean not null default false,
  delivered               boolean not null default false,
  read                    boolean not null default false,
  failed                  boolean not null default false,
  error_code              text,
  failure_reason          text,
  status_flags_conflict   boolean not null default false,  -- true for the delivered-not-sent / read-not-delivered rows the sample export contained
  attributed_order_id     text,     -- Phase 3, once order-level join exists
  attributed_revenue      numeric(12,2),
  -- Fingerprint used for duplicate-import protection: same campaign + same
  -- phone re-uploaded updates this row rather than inserting a second one.
  unique (campaign_id, recipient_phone)
);

create index idx_campaign_recipients_campaign on marketing.campaign_recipients (campaign_id);
create index idx_campaign_recipients_error on marketing.campaign_recipients (error_code) where error_code is not null;

-- Aggregated metrics, derived FROM campaign_recipients (never entered directly)
-- — Section 19's campaign_metrics table, computed as a view so it can never
-- drift from the recipient-level rows.
create or replace view marketing.vw_campaign_metrics
with (security_invoker = on) as
select
  campaign_id,
  count(*) filter (where attempted)                                          as sent_count_attempted,
  count(*) filter (where sent)                                                as sent_count,
  count(*) filter (where delivered)                                           as delivered_count,
  count(*) filter (where failed)                                              as failed_count,
  count(*) filter (where read)                                                as read_count,
  round(100.0 * count(*) filter (where delivered) / nullif(count(*) filter (where sent), 0), 2)  as delivery_rate,
  round(100.0 * count(*) filter (where read) / nullif(count(*) filter (where delivered), 0), 2)  as read_rate,
  count(*) filter (where attributed_order_id is not null)                     as attributed_orders,
  sum(attributed_revenue)                                                     as attributed_revenue,
  count(*) filter (where status_flags_conflict)                               as contradictory_status_count
from marketing.campaign_recipients
group by campaign_id;

create or replace view marketing.vw_campaign_failure_reasons
with (security_invoker = on) as
select
  campaign_id, error_code, failure_reason,
  count(*)                                     as recipient_count,
  round(100.0 * count(*) / sum(count(*)) over (partition by campaign_id), 1) as pct_of_failures
from marketing.campaign_recipients
where failed
group by campaign_id, error_code, failure_reason;

-- ---------------------------------------------------------------------------
-- Campaign impact on store sales — three explicit evidence tiers (Section 22).
-- Never labelled ROI; never captions correlation as causation.
-- ---------------------------------------------------------------------------
create or replace view marketing.vw_campaign_store_impact
with (security_invoker = on) as
select
  cs.campaign_id, cs.store_id, c.campaign_date,
  pre.net_sales   as net_sales_7d_before,
  post.net_sales  as net_sales_7d_after,
  round(100.0 * (post.net_sales - pre.net_sales) / nullif(pre.net_sales, 0), 2) as sales_change_pct,
  case
    when exists (select 1 from marketing.campaign_recipients r where r.campaign_id = cs.campaign_id and r.attributed_order_id is not null)
      then 'DIRECT_ATTRIBUTION'
    else 'OBSERVATIONAL_CHANGE'
  end as evidence_tier
from marketing.campaign_stores cs
join marketing.campaigns c on c.id = cs.campaign_id
left join lateral (
  select sum(net_sales) as net_sales from sales.vw_ebo_sales_daily
  where store_id = cs.store_id and bill_date between c.campaign_date - 7 and c.campaign_date - 1
) pre on true
left join lateral (
  select sum(net_sales) as net_sales from sales.vw_ebo_sales_daily
  where store_id = cs.store_id and bill_date between c.campaign_date and c.campaign_date + 6
) post on true;

comment on view marketing.vw_campaign_store_impact is
  'evidence_tier is DIRECT_ATTRIBUTION only once campaign_recipients.attributed_order_id is populated by a phone-number join against the ERP bill (Phase 3 — customer phone is confirmed captured at billing but not yet exposed in the sales SQL view). Until then every row is OBSERVATIONAL_CHANGE, and the app must show the day-of-week composition of the before/after windows alongside this — a weekend-heavy post-window inflates sales_change_pct for reasons having nothing to do with the campaign.';

grant select on marketing.vw_campaign_metrics, marketing.vw_campaign_failure_reasons,
                 marketing.vw_campaign_store_impact
  to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table marketing.campaign_import_batches enable row level security;
alter table marketing.campaigns enable row level security;
alter table marketing.campaign_stores enable row level security;
alter table marketing.campaign_recipients enable row level security;

create policy campaigns_read on marketing.campaigns for select using (true);
create policy campaigns_write on marketing.campaigns for insert with check (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);
create policy campaigns_update on marketing.campaigns for update using (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);

create policy campaign_stores_read on marketing.campaign_stores for select using (
  store_id = any (core.fn_user_store_ids())
);
create policy campaign_stores_write on marketing.campaign_stores for insert with check (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);

create policy campaign_recipients_read on marketing.campaign_recipients for select using (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);
create policy campaign_recipients_write on marketing.campaign_recipients for insert with check (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);

create policy import_batches_rw on marketing.campaign_import_batches for all using (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
) with check (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);
