import "server-only";

const API_VERSION = "2024-01";

type ShopifyVariant = {
  option1: string | null;
  inventory_quantity: number | null;
};
type ShopifyProduct = {
  title: string;
  status: string;
  tags: string;
  variants: ShopifyVariant[];
};

// Same normalize/extract rules as the Shopify image-uploader project
// (D:\Py\Shopify image uploader\upload_images.py's normalize_color /
// extract_style_code) - ported here rather than shared since this is a
// separate TS/Next app reading the same Shopify store. A style/colour key
// built here MUST match a key built from lib/stockStatus/aggregate.ts's WH
// side, or every row would show as "not on Shopify" purely from a naming
// mismatch, never a real one.
function normalizeColor(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "");
}

function extractStyleCode(product: ShopifyProduct): string | null {
  for (const rawTag of (product.tags || "").split(",")) {
    const tag = rawTag.trim();
    if (tag.startsWith("StyleCode-")) return tag.slice("StyleCode-".length);
  }
  return null;
}

export type ShopifyInventory = {
  /** "style::colour" -> summed inventory_quantity across that colour's size variants (already aggregated across every location by Shopify's REST payload). */
  sohByKey: Map<string, number>;
  titleByStyle: Map<string, string>;
  statusByStyle: Map<string, string>;
};

/**
 * Live paginated fetch of EVERY product from Shopify's REST Admin API - same
 * endpoint, pagination (Link header rel="next"), and "no exclusions" rule as
 * Wingman's own live-fetch mode (D:\Py\Shopify image uploader\server\main.py,
 * _fetch_products_live). Ported rather than shared: separate app, separate
 * language. Always live - no cached/stored snapshot, matching the Wingman
 * feature this is ported from (staleness would defeat the point of a
 * discrepancy check).
 */
export async function fetchShopifyInventory(): Promise<ShopifyInventory> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!domain || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN in env");
  }
  const base = `https://${domain}/admin/api/${API_VERSION}`;
  const headers = { "X-Shopify-Access-Token": token };

  const sohByKey = new Map<string, number>();
  const titleByStyle = new Map<string, string>();
  const statusByStyle = new Map<string, string>();

  let path: string | null = "/products.json?limit=250";
  while (path) {
    const res: Response = await fetch(`${base}${path}`, { headers, cache: "no-store" });
    if (!res.ok) {
      const body: string = await res.text().catch(() => "");
      throw new Error(`Shopify API error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { products: ShopifyProduct[] };
    for (const product of data.products ?? []) {
      const style = extractStyleCode(product);
      if (!style) continue;
      titleByStyle.set(style, product.title ?? "");
      statusByStyle.set(style, product.status ?? "");
      for (const variant of product.variants ?? []) {
        const colour = normalizeColor(variant.option1);
        if (!colour) continue;
        const key = `${style}::${colour}`;
        sohByKey.set(key, (sohByKey.get(key) ?? 0) + (variant.inventory_quantity ?? 0));
      }
    }

    const link: string = res.headers.get("Link") ?? "";
    path = null;
    for (const part of link.split(",")) {
      if (part.includes('rel="next"')) {
        const match: RegExpMatchArray | null = part.match(/<([^>]+)>/);
        if (match) path = match[1]!.replace(base, "");
      }
    }
  }

  return { sohByKey, titleByStyle, statusByStyle };
}
