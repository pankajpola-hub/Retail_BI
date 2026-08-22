-- =============================================================================
-- 0064 · raw_uniware.sale_order_items — brand/MRP/discount, verified live
-- =============================================================================
-- 0063 was written from the WSDL's declared type names before a real
-- GetSaleOrder call had been made. A live call (order 36d099c9-...,
-- 2026-08-22) landed right after 0063 was applied and showed real field
-- names/values differ in places (GiftWrapCharges not GiftWrap — already
-- mapped correctly into the existing gift_wrap column, no fix needed there)
-- and surfaced three real, useful fields 0063 didn't capture at all: Brand,
-- MaxRetailPrice, Discount. Retail's raw_logic.sales_transactions and
-- raw_logic.item_master both track MRP/discount already (0030, 0054) — for
-- Ecomm to be comparably analysable, its line items need the same facts,
-- not a narrower set.

alter table raw_uniware.sale_order_items
  add column if not exists brand    text,
  add column if not exists mrp      numeric,
  add column if not exists discount numeric,
  add column if not exists hsn_code text;

comment on column raw_uniware.sale_order_items.mrp is
  'From GetSaleOrder''s MaxRetailPrice — the printed MRP, distinct from selling_price/total_price. Same distinction raw_logic.sales_transactions.mrp draws for Retail (0030).';
comment on column raw_uniware.sale_order_items.discount is
  'From GetSaleOrder''s Discount — the per-item discount amount as Uniware itself computes it (not derived from mrp - selling_price, which may not net out identically once taxes/charges are involved).';
