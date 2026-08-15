-- =============================================================================
-- 0002 · Retail calendar (Mon→Sun weeks)
-- =============================================================================
-- Every WOW/MOM/YOY calculation in this platform joins through this table
-- rather than doing date arithmetic inline, so "what counts as a week" is
-- defined in exactly one place.

create table core.retail_calendar (
  date                date primary key,
  day_name            text not null,                 -- 'Monday' … 'Sunday'
  day_number          smallint not null,              -- 1 = Mon … 7 = Sun (ISO)
  week_start          date not null,                  -- Monday of this date's retail week
  week_end            date not null,                  -- Sunday of this date's retail week
  retail_week         smallint not null,               -- ISO week number, 1-53
  retail_year         smallint not null,               -- ISO week-year (handles Dec/Jan boundary weeks)
  retail_month        smallint not null,               -- calendar month, 1-12
  retail_month_name   text not null,
  retail_quarter      smallint not null,
  financial_year      text not null,                   -- e.g. 'FY2026-27', assumes Apr–Mar; adjust if different
  month_start         date not null,
  month_end           date not null,
  is_weekend          boolean not null,
  prev_retail_week_start date not null,                -- week_start - 7, for WOW joins
  same_week_last_year_start date not null              -- ISO week-aligned, not naive -365d
);

create index idx_retail_calendar_week_start on core.retail_calendar (week_start);
create index idx_retail_calendar_month_start on core.retail_calendar (month_start);
create index idx_retail_calendar_retail_year_week on core.retail_calendar (retail_year, retail_week);

comment on column core.retail_calendar.same_week_last_year_start is
  'Monday of the ISO week one year prior with the same retail_week number — used for YOY on equivalent retail periods rather than naive date - 365.';

-- Populate a wide range up front (2023-2028 covers several years either side of
-- go-live; extend later by re-running with new bounds — INSERT ... ON CONFLICT
-- DO NOTHING makes that safe to repeat).
insert into core.retail_calendar
select
  d,
  to_char(d, 'FMDay'),
  extract(isodow from d)::smallint,
  d - (extract(isodow from d)::int - 1),
  d - (extract(isodow from d)::int - 1) + 6,
  extract(week from d)::smallint,
  extract(isoyear from d)::smallint,
  extract(month from d)::smallint,
  to_char(d, 'FMMonth'),
  extract(quarter from d)::smallint,
  case when extract(month from d) >= 4
       then 'FY' || extract(year from d)::int::text || '-' || right((extract(year from d)::int + 1)::text, 2)
       else 'FY' || (extract(year from d)::int - 1)::text || '-' || right(extract(year from d)::int::text, 2)
  end,
  date_trunc('month', d)::date,
  (date_trunc('month', d) + interval '1 month' - interval '1 day')::date,
  extract(isodow from d) in (6, 7),
  d - (extract(isodow from d)::int - 1) - 7,
  d - (extract(isodow from d)::int - 1) - 364    -- 52 ISO weeks back, same weekday
from (
  select generate_series('2023-01-01'::date, '2028-12-31'::date, interval '1 day')::date as d
) series
on conflict (date) do nothing;
