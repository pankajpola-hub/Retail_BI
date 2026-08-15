-- =============================================================================
-- 0017 · Agent-wise and hour-of-day sales views
-- =============================================================================
-- Both requested for the network dashboard. Built directly off
-- sales.vw_ebo_sales_lines (SALE lines only — agent attribution on a return
-- line just tells you who processed the refund, not who made the sale, so
-- returns are excluded rather than counted against an agent's numbers).

create or replace view sales.vw_ebo_agent_daily
with (security_invoker = on) as
select
  store_id,
  bill_date,
  coalesce(agent_name, 'Unassigned')                    as agent_name,
  count(distinct bill_no)                                as bills,
  sum(total_quantity)                                     as quantity,
  sum(gross_amount)                                        as gross_sales,
  sum(discount_amount)                                      as discount,
  sum(net_amount)                                            as net_sales
from sales.vw_ebo_sales_lines
where bill_type = 'SALE'
group by store_id, bill_date, coalesce(agent_name, 'Unassigned');

comment on view sales.vw_ebo_agent_daily is
  'One row per store x day x agent. "Unassigned" covers rows with no agent_name — most likely older exports from before that column existed, not missing data on a given line.';

create or replace view sales.vw_ebo_sales_hourly
with (security_invoker = on) as
select
  store_id,
  bill_date,
  extract(hour from bill_time)::smallint                as bill_hour,
  count(distinct bill_no)                                 as bills,
  sum(total_quantity)                                      as quantity,
  sum(net_amount)                                           as net_sales
from sales.vw_ebo_sales_lines
where bill_type = 'SALE' and bill_time is not null
group by store_id, bill_date, extract(hour from bill_time);

comment on view sales.vw_ebo_sales_hourly is
  'Rows only exist for lines with a parseable bill_time — silently absent, not zero, for any date/store where the source didn''t supply a time (older exports). The app must not read a missing hour as "no sales that hour".';

grant select on sales.vw_ebo_agent_daily, sales.vw_ebo_sales_hourly to authenticated;
