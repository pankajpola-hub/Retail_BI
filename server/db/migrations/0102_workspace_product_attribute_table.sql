-- =============================================================================
-- 0102 · D-05 parity item 2 — register `product_attribute_table` in the
--        workspace component registry (plain additive INSERT, no schema
--        change) so Workspace can offer the same product-attribute
--        breakdown app/(ho)/sales/page.tsx's ProductAttributeSection ships.
-- =============================================================================
-- BACKGROUND: docs/audit/D-frontend.md's "Sales -> Workspace parity diff",
-- item 2, catalogues six Sales features Workspace lacked (D-05). Items 1
-- (comparison), 3+4+5 (grain toggle / faceting / network-total styling) and 6
-- (streaming/error boundaries) were ported in three earlier commits on this
-- branch without needing a migration — none of them introduced a NEW
-- component id, only changed the behaviour of ids already registered by 0047.
-- This one does: web/lib/workspace/renderSalesComponents.tsx gained a new
-- renderer id, `product_attribute_table`, wired to the SAME
-- ProductAttributeSalesTable component (web/app/(ho)/sales/
-- ProductAttributeSalesTable.tsx) and the SAME aggregation module
-- (web/lib/sales/attributeBreakdown.ts) the Sales page already uses.
--
-- workspace/page.tsx filters the registry it reads by `.in("id", wiredIds)`
-- (wiredIds = every key across the *_COMPONENT_RENDERERS maps) — an id with a
-- renderer but no registry row still renders (the AddComponentPicker/grid
-- label falls back to the bare id), but with no name/description/sizing/cost
-- hint, and it would never appear in that `.in()` filter's result set at all,
-- so the picker would offer it with `name: id` and `cost: "low"` (page.tsx's
-- own fallback), which is wrong for a line-grain fetch. Hence this row.
--
-- COST: 'high', matching the other line-grain/large-payload registry rows
-- (0047's ecomm_channel_table etc.) — this is the only NON-pre-aggregated
-- query in the whole Sales family (everything else here reads a rollup view),
-- fetched via fetchAllRows against sales.vw_ebo_sale_attribute_lines with no
-- server-side cap, same reasoning as sales/page.tsx's own ProductAttributeSection
-- header comment. The 'high' cost hint is why this fetch is NOT folded into
-- fetchSalesComponentData's shared Promise.all in renderSalesComponents.tsx —
-- it runs as its own gated promise in workspace/page.tsx (needsProductAttributeData),
-- only when a product_attribute_table component is actually on the workspace,
-- exactly as the audit's "Port needs (c)" called for.
--
-- source_page/requires_page_key: 'network', matching every sibling Sales
-- registry row from 0047 (sales_kpi_grid, weekly_sales_table, ...) even though
-- the actual page now lives at app/(ho)/sales/page.tsx — there is still no
-- distinct "sales" PageKey in web/lib/auth/roles.ts (PAGE_ROLE_DEFAULTS has no
-- "sales" entry), /sales is reached by the same role set 'network' already
-- gates, and every other row in this family already carries the historical
-- 'network' source_page/requires_page_key pair post-rename — this row follows
-- that established (if now slightly stale-labelled) convention rather than
-- inventing a new, inconsistent one.
-- =============================================================================

insert into workspace.component_definitions
  (id, name, category, description, source_page, requires_page_key,
   supported_metrics, supported_dimensions, supported_comparisons, supported_periods, supported_visuals,
   min_w, min_h, default_w, default_h, cost, load, is_interactive)
values
  ('product_attribute_table', 'Sales by product attribute (EBO)', 'sales',
   'EBO-only line-grain breakdown of net sales/gross/qty/returns by drag-to-combine product attributes (season, category, gender, size group, market segment, color, MRP range), Season+Year by default. app/(ho)/sales/page.tsx ProductAttributeSection, rendered via app/(ho)/sales/ProductAttributeSalesTable.tsx.',
   'network', 'network',
   array['net_sales','gross_sales','sale_quantity','returns_value'], array['season','season_year','category','subcategory','gender','size_group','market_segment','shade','mrp_range'], array['none'], array['custom'], array['table'],
   6, 4, 8, 5, 'high', 'eager', false)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
