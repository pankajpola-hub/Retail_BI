-- =============================================================================
-- 0084 · Add mrp to sales.vw_stock_with_scheme (Sale vs Stock Mix, attribute view)
-- =============================================================================
-- Sale vs Stock Mix (Movement page) is getting an attribute-wise view: group
-- by color/size/gender/season/MRP range instead of only style+color. Every
-- attribute except MRP is already exposed by this view (0056). MRP itself is
-- in raw_logic.item_master but was deliberately never surfaced anywhere —
-- 0056's own view comment says "item_master.mrp is never read here or
-- anywhere else in the app." That was correct at the time (nothing needed
-- it); it's the one field this feature is missing, so it's added here.
--
-- rate (from raw_logic.stock_snapshot) stays untouched and distinct from mrp
-- — they come from different source tables and are not guaranteed equal.

create or replace view sales.vw_stock_with_scheme
with (security_invoker = off, security_barrier = true) as
select
  ss.id, ss.branch_name, ss.godown_name, ss.company_name,
  coalesce(nullif(trim(im.season), ''), ss.season)                       as season,
  coalesce(nullif(trim(im.market_segment), ''), ss.market_segment)       as market_segment,
  coalesce(nullif(trim(im.gender), ''), nullif(trim(ss.gender), ''))     as gender,
  coalesce(nullif(trim(im.size_group), ''), nullif(trim(ss.size_group), '')) as size_group,
  coalesce(nullif(trim(im.subcategory), ''), ss.subcategory)             as subcategory,
  ss.item_code,
  coalesce(nullif(trim(im.item_name), ''), ss.item_name)                 as item_name,
  coalesce(nullif(trim(im.shade_name), ''), ss.shade_name)               as shade_name,
  ss.size, ss.closing_stock, ss.rate,
  sl.scheme_name,
  sl.discount_pct,
  coalesce(sl.is_discounted_50plus, false) as is_eoss,
  im.mrp
from raw_logic.stock_snapshot ss
left join raw_logic.item_master im on im.item_code = ss.item_code
left join raw_logic.scheme_lookup sl on sl.item_code = ss.item_code;

comment on view sales.vw_stock_with_scheme is
  'Stock snapshot rows enriched with scheme/EOSS info (0024), product-attribute fields (0056: item_name, shade_name, season, market_segment, gender, size_group, subcategory), and mrp (0084, from raw_logic.item_master — used by Sale vs Stock Mix''s attribute-wise view). rate (from stock_snapshot) and mrp (from item_master) are separate fields from separate source tables and are not guaranteed to match.';

grant select on sales.vw_stock_with_scheme to authenticated;

notify pgrst, 'reload schema';
