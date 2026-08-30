// Normalized channel registry - the frontend/aggregation layer reasons in
// terms of THIS list, never a hardcoded "Shopify is the only channel"
// assumption, so adding a real Myntra/Ajio/Amazon adapter later is a
// one-line registry change plus a real adapter, not a UI rewrite.
//
// `active` is the honest-data gate: only Shopify has a working inventory
// adapter today (web/lib/shopify/client.ts). Every other row here is a
// real channel this business sells on, kept in the registry so the UI can
// show it as "Not connected" rather than silently omitting it - but its
// numbers must never be fabricated. See lib/stockStatus/aggregate.ts for
// where `active` gates real computation vs. a placeholder.
export type ChannelDef = {
  id: string;
  name: string;
  sourceSystem: "SHOPIFY_API" | "UNIWARE_API";
  active: boolean;
};

export const CHANNELS: ChannelDef[] = [
  { id: "shopify", name: "Shopify", sourceSystem: "SHOPIFY_API", active: true },
  // Myntra/Ajio/Amazon inventory would come via a UniwareInventoryAdapter -
  // web/lib/uniware/client.ts today only implements Orders/Returns/Tax
  // Detail, no inventory/listing endpoint. Left `active: false` rather than
  // removed, so the comparison table always shows every real sales channel
  // this business has, with an honest "Not connected" status for the ones
  // without a live feed yet.
  { id: "myntra", name: "Myntra", sourceSystem: "UNIWARE_API", active: false },
  { id: "ajio", name: "Ajio", sourceSystem: "UNIWARE_API", active: false },
  { id: "amazon", name: "Amazon", sourceSystem: "UNIWARE_API", active: false },
];

export type ChannelSummary = {
  channelId: string;
  channelName: string;
  active: boolean;
  liveSkus: number;
  sellableUnits: number;
  whEligibleUnits: number;
  missingUnits: number; // WH has stock, this channel doesn't (== "can go live" scoped to this one channel)
  mismatchUnits: number;
  availabilityPct: number | null; // sellableUnits / whEligibleUnits, null when whEligibleUnits is 0
};
