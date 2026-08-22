import "server-only";
import { XMLParser } from "fast-xml-parser";

/**
 * Uniware (Unicommerce) SOAP API v1.9 client — Ecomm data source (0063's
 * raw_uniware schema). VERIFIED against the live tenant
 * (peppermint.unicommerce.com, 2026-08-22), not written from public docs
 * alone: those describe a REST/OAuth2 flow that does not apply to this
 * tenant's SOAP-only setup, and an early attempt at the WS-Security header
 * failed silently on a wrong Password `Type` URI before being corrected
 * against D:\Py\VMS_Peppermint's already-working implementation for this
 * same tenant (see that project's backend/app/services/uniware.py, which
 * this file's request-building mirrors).
 *
 * Single endpoint for every operation: {UNIWARE_BASE_URL}/services/soap/?version=1.9
 * (document/literal "wrapped" style — every body element needs the `ser:`
 * prefix, or the server rejects it with a JiBX unmarshalling fault).
 *
 * Auth is WS-Security UsernameToken IN THE SOAP HEADER, not HTTP Basic and
 * not OAuth2 (confirmed live: a request with no security header gets
 * faultstring "No WS-Security header found"). Username + APIKey are issued
 * PER OPERATION from Uniware's own Settings -> API screen — this tenant has
 * a `retail_bi` key (used here for SearchSaleOrder) and a
 * `get_sale_order_details` key (used for GetSaleOrder); each credential pair
 * only works for the operation(s) it was created for.
 */

const ENV_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const SER_NS = "http://uniware.unicommerce.com/services/";
const WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
// NOTE the exact URI — no "wssecurity-" segment before "username-token-profile".
// A copy-paste variant with that extra segment looks plausible (it matches
// the sibling secext URI above) but is silently rejected: the server still
// returns HTTP 200 with a generic "security token could not be authenticated
// or authorized" fault, which reads exactly like a wrong username/password.
// Confirmed live 2026-08-22 — do not "simplify" this back to the wrong form.
const WSSE_PWD_TYPE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText";

const xmlParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false, // keep everything as strings; callers parse numbers/dates explicitly
});

export class UniwareSoapError extends Error {}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** POSTs a document/literal SOAP request and returns the parsed `<{operation}Response>` body. */
async function soapCall(
  operation: string,
  innerXml: string,
  username: string,
  apiKey: string
): Promise<Record<string, unknown>> {
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="${ENV_NS}" xmlns:ser="${SER_NS}">` +
    "<soapenv:Header>" +
    `<wsse:Security xmlns:wsse="${WSSE_NS}" soapenv:mustUnderstand="1">` +
    "<wsse:UsernameToken>" +
    `<wsse:Username>${escapeXml(username)}</wsse:Username>` +
    `<wsse:Password Type="${WSSE_PWD_TYPE}">${escapeXml(apiKey)}</wsse:Password>` +
    "</wsse:UsernameToken>" +
    "</wsse:Security>" +
    "</soapenv:Header>" +
    `<soapenv:Body><ser:${operation}Request>${innerXml}</ser:${operation}Request></soapenv:Body>` +
    "</soapenv:Envelope>";

  const res = await fetch(`${process.env.UNIWARE_BASE_URL}/services/soap/?version=1.9`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: envelope,
    cache: "no-store", // Next.js patches global fetch and caches by default even for non-GET requests in some cases — every call here must hit Uniware live, never a stale/memoized response.
  });

  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = xmlParser.parse(text);
  } catch {
    throw new UniwareSoapError(`Non-XML response from ${operation} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  const envelopeEl = parsed.Envelope as Record<string, unknown> | undefined;
  const bodyEl = envelopeEl?.Body as Record<string, unknown> | undefined;
  if (!bodyEl) throw new UniwareSoapError(`Empty SOAP body from ${operation} (HTTP ${res.status})`);

  if (bodyEl.Fault) {
    const fault = bodyEl.Fault as Record<string, unknown>;
    throw new UniwareSoapError(`${operation}: ${textOr(fault.faultstring) || "Unknown SOAP fault"}`);
  }

  const responseEl = bodyEl[`${operation}Response`] as Record<string, unknown> | undefined;
  if (!responseEl) throw new UniwareSoapError(`Unexpected response shape from ${operation}`);

  if (responseEl.Successful === "false") {
    const errors = responseEl.Errors as { Error?: unknown } | undefined;
    const list = errors?.Error ? (Array.isArray(errors.Error) ? errors.Error : [errors.Error]) : [];
    const msgs = list.map((e) => {
      const err = e as Record<string, unknown>;
      return String(err["@_message"] ?? err["@_code"] ?? "Unknown error");
    });
    throw new UniwareSoapError(msgs.join("; ") || `${operation} failed`);
  }

  return responseEl;
}

// -----------------------------------------------------------------------------
// SearchSaleOrder — order headers, paginated by date range
// -----------------------------------------------------------------------------

export type UniwareOrderHeader = {
  code: string;
  displayOrderCode: string;
  channel: string;
  status: string;
  orderDatetime: string | null;
  createdOn: string | null;
  updatedOn: string | null;
  notificationEmail: string;
  notificationMobile: string;
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// fast-xml-parser (with ignoreAttributes: false) represents an element that
// has BOTH attributes and text content as an object ({ "@_xml:lang": "en",
// "#text": "..." }), not a plain string — hit live on SOAP faults, whose
// <faultstring xml:lang="en"> always carries that attribute. Handling only
// the plain-string case here silently produced "" for real values on any
// tag with an attribute (confirmed live: a Fault's faultstring stringified
// to "[object Object]" before this fix).
function textOr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) return String((value as Record<string, unknown>)["#text"]);
  return "";
}

/**
 * One page of SearchSaleOrder. FromDate/ToDate filter on the order's
 * placement date (DisplayOrderDateTime) — confirmed against the tenant's
 * WSDL, there is no "updated since" filter for this operation (unlike
 * SearchShippingPackage's UpdatedSinceInMinutes), which is why the sync job
 * re-pulls a rolling window rather than tracking a cursor — see
 * 0063_raw_uniware.sql's header.
 */
export async function searchSaleOrders(
  fromDate: Date,
  toDate: Date,
  displayStart: number,
  displayLength: number
): Promise<{ orders: UniwareOrderHeader[]; totalRecords: number }> {
  const username = process.env.UNIWARE_SEARCH_API_USERNAME!;
  const apiKey = process.env.UNIWARE_SEARCH_API_KEY!;

  const inner =
    `<ser:FromDate>${fromDate.toISOString()}</ser:FromDate>` +
    `<ser:ToDate>${toDate.toISOString()}</ser:ToDate>` +
    `<ser:SearchOptions><ser:DisplayStart>${displayStart}</ser:DisplayStart>` +
    `<ser:DisplayLength>${displayLength}</ser:DisplayLength></ser:SearchOptions>`;

  const response = await soapCall("SearchSaleOrder", inner, username, apiKey);
  const totalRecords = Number(response.TotalRecords ?? 0);
  const saleOrdersEl = response.SaleOrders as { SaleOrder?: unknown } | undefined;
  const orders = asArray(saleOrdersEl?.SaleOrder).map((raw) => {
    const o = raw as Record<string, unknown>;
    return {
      code: textOr(o.Code),
      displayOrderCode: textOr(o.DisplayOrderCode),
      channel: textOr(o.Channel),
      status: textOr(o.Status),
      orderDatetime: textOr(o.DisplayOrderDateTime) || null,
      createdOn: textOr(o.CreatedOn) || null,
      updatedOn: textOr(o.UpdatedOn) || null,
      notificationEmail: textOr(o.NotificationEmail),
      notificationMobile: textOr(o.NotificationMobile),
    };
  });

  return { orders, totalRecords };
}

// -----------------------------------------------------------------------------
// GetSaleOrder — per-order line-item enrichment
// -----------------------------------------------------------------------------

export type UniwareOrderItem = {
  itemCode: string;
  itemSku: string;
  itemName: string;
  size: string;
  color: string;
  brand: string;
  statusCode: string;
  facilityCode: string;
  sellingPrice: number | null;
  totalPrice: number | null;
  shippingCharges: number | null;
  giftWrapCharges: number | null;
  mrp: number | null;
  discount: number | null;
  hsnCode: string;
  createdOn: string | null;
  updatedOn: string | null;
};

function numOr(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * GetSaleOrder -> header (re-confirms the same fields SearchSaleOrder
 * already gave, ignored here — the sync job only calls this for items) plus
 * SaleOrderItems, one row per line. Field names below are taken from a real
 * live response (order 36d099c9-..., 2026-08-22), not the WSDL's declared
 * type names, which differ in casing/naming in a few places (e.g. real
 * responses use `ItemSKU`, `GiftWrapCharges` — see 0064_raw_uniware_item_fields.sql).
 */
export async function getSaleOrderItems(saleOrderCode: string): Promise<UniwareOrderItem[]> {
  const username = process.env.UNIWARE_GETORDER_API_USERNAME!;
  const apiKey = process.env.UNIWARE_GETORDER_API_KEY!;

  const inner =
    `<ser:SaleOrder><ser:Code>${escapeXml(saleOrderCode)}</ser:Code></ser:SaleOrder>` +
    "<ser:IsPaymentDetailRequired>false</ser:IsPaymentDetailRequired>";

  const response = await soapCall("GetSaleOrder", inner, username, apiKey);
  const orderEl = response.SaleOrder as Record<string, unknown> | undefined;
  if (!orderEl) return [];

  const itemsEl = orderEl.SaleOrderItems as { SaleOrderItem?: unknown } | undefined;
  return asArray(itemsEl?.SaleOrderItem).map((raw) => {
    const it = raw as Record<string, unknown>;
    return {
      itemCode: textOr(it.Code),
      itemSku: textOr(it.ItemSKU),
      itemName: textOr(it.ItemName),
      size: textOr(it.Size),
      color: textOr(it.Color),
      brand: textOr(it.Brand),
      statusCode: textOr(it.StatusCode),
      facilityCode: textOr(it.FacilityCode),
      sellingPrice: numOr(it.SellingPrice),
      totalPrice: numOr(it.TotalPrice),
      shippingCharges: numOr(it.ShippingCharges),
      giftWrapCharges: numOr(it.GiftWrapCharges),
      mrp: numOr(it.MaxRetailPrice),
      discount: numOr(it.Discount),
      hsnCode: textOr(it.HsnCode),
      createdOn: textOr(it.CreatedOn) || null,
      updatedOn: textOr(it.UpdatedOn) || null,
    };
  });
}

// -----------------------------------------------------------------------------
// Returns — REST v1, OAuth2 `password` grant. A COMPLETELY SEPARATE API from
// everything above: different auth (OAuth2, not WS-Security), different
// transport (JSON over REST, not SOAP), different credential pair
// (UNIWARE_REST_USERNAME/PASSWORD, not the Search/GetOrder SOAP keys).
//
// Why a separate API at all: the SOAP API (VERIFIED live, see this file's
// header) has no way to search returns — SearchShippingPackage only indexes
// forward shipments, and GetSaleOrder's <Returns> block needs a sale order
// code you already have. Confirmed by D:\Py\VMS_Peppermint's
// backend/app/services/uniware.py (same tenant, same company) hitting exactly
// this wall and building this REST path instead — this file's restToken/
// restCall/searchReturns/getReturn mirror that project's proven
// _rest_token/_rest_call/search_returns/get_return implementation.
//
// VERIFIED live 2026-08-22 (real REST credentials + UNIWARE_FACILITY_CODE,
// see .env.local's comments) — 1706 real return codes found, 150 fetched via
// Get Return, all fields below confirmed against real response payloads, not
// the originally-authored guess. Two things worth remembering from getting
// this working: (1) grant_type=password's OAuth token step failed with a
// generic "Invalid credentials" until UNIWARE_REST_PASSWORD was double-quoted
// in .env.local — an unquoted trailing `#` is parsed as a comment by .env
// loaders, silently truncating the password; (2) the search itself then
// failed with "403 Illegal Access, facility is required" until
// UNIWARE_FACILITY_CODE was set (required by restCall's Facility header,
// this tenant's single warehouse is WH-PNQ-DH). getReturn() still returns the
// full raw payload regardless, so any field this doesn't model explicitly
// isn't lost.
// -----------------------------------------------------------------------------

export class UniwareRestError extends Error {}

let restTokenCache: { accessToken: string; expiresAt: number } | null = null;

/** Whether UNIWARE_REST_USERNAME/PASSWORD are configured — lets the cron job skip the returns phase quietly instead of failing every run when they're not set yet. */
export function uniwareRestEnabled(): boolean {
  return Boolean(process.env.UNIWARE_REST_USERNAME && process.env.UNIWARE_REST_PASSWORD);
}

/**
 * Fetches (and caches for its lifetime) an OAuth2 access token via the
 * `password` grant. Mirrors VMS's _rest_token(): POST {base}/oauth/token
 * with grant_type=password&client_id=my-trusted-client&username=...&password=...
 * as query params (confirmed live by VMS against this same tenant — not
 * a JSON body).
 */
async function restToken(): Promise<string | null> {
  const nowSeconds = Date.now() / 1000;
  if (restTokenCache && restTokenCache.expiresAt > nowSeconds + 30) {
    return restTokenCache.accessToken;
  }
  if (!uniwareRestEnabled()) return null;

  const url = new URL(`${process.env.UNIWARE_BASE_URL}/oauth/token`);
  url.searchParams.set("grant_type", "password");
  url.searchParams.set("client_id", "my-trusted-client");
  url.searchParams.set("username", process.env.UNIWARE_REST_USERNAME!);
  url.searchParams.set("password", process.env.UNIWARE_REST_PASSWORD!);

  const res = await fetch(url.toString(), { method: "POST", cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw new UniwareRestError(`OAuth2 token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UniwareRestError(`Non-JSON OAuth2 token response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  const token = data.access_token;
  if (typeof token !== "string" || !token) return null;

  restTokenCache = { accessToken: token, expiresAt: nowSeconds + Number(data.expires_in ?? 0) };
  return token;
}

/** POSTs a JSON REST v1 request with the OAuth2 bearer token; returns the parsed JSON body. */
async function restCall(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const token = await restToken();
  if (!token) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  // Same facility-scoping header VMS sends on every REST call when configured
  // (UNIWARE_FACILITY_CODE — already present in this project's .env.local for
  // the SOAP side per D:\Py\VMS_Peppermint, harmless to omit if unset).
  if (process.env.UNIWARE_FACILITY_CODE) headers["Facility"] = process.env.UNIWARE_FACILITY_CODE;

  const res = await fetch(`${process.env.UNIWARE_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new UniwareRestError(`${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UniwareRestError(`Non-JSON response from ${path} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Search Return — returns the bare list of return codes created in
 * [fromDate, toDate]. fromDate/toDate MUST be "yyyy-MM-dd" (date-only;
 * "yyyy-MM-dd HH:mm:ss" is rejected — confirmed live by VMS against this
 * tenant) and the window MUST be <=30 days (Search Return rejects wider
 * spans with INVALID_TIME_INTERVAL, confirmed live: 30 days OK, 45 days
 * fails) — callers (the cron job) are responsible for chunking a wider
 * lookback into <=30-day windows, same responsibility split as
 * searchSaleOrders' caller owning HEADER_CHUNK_DAYS.
 *
 * No pagination parameters exist on this endpoint at all (confirmed live by
 * VMS: displayStart/displayLength are rejected as unrecognized fields) — the
 * full result for the window comes back in one call.
 */
export async function searchReturns(fromDate: string, toDate: string): Promise<string[]> {
  const data = await restCall("/services/rest/v1/oms/return/search", {
    returnType: "CIR",
    createdFrom: fromDate,
    createdTo: toDate,
  });
  if (!data) return [];
  const returnOrders = Array.isArray(data.returnOrders) ? data.returnOrders : [];
  return returnOrders
    .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>).code : undefined))
    .filter((code): code is string => typeof code === "string" && code.length > 0);
}

export type UniwareReturnDetail = {
  reversePickupCode: string;
  saleOrderCode: string | null;
  returnAwb: string | null;
  status: string | null;
  createdOn: string | null;
  updatedOn: string | null;
  raw: Record<string, unknown>;
};

/**
 * Get Return — per-code detail. Field mapping CONFIRMED against a real
 * response (2026-08-22, once REST credentials + UNIWARE_FACILITY_CODE were
 * both correctly configured): everything relevant lives under
 * returnSaleOrderValue — .saleOrderCode, .trackingNumber, .returnStatus
 * (e.g. "COURIER_ALLOCATED"), .returnCreatedDate ("yyyy-MM-dd HH:mm:ss").
 * The earlier version of this function guessed at a top-level data.status/
 * data.createdDate shape that doesn't exist in the real payload — those
 * always resolved to null (caught by inspecting `raw` on real rows, not by
 * an error, since the upsert never rejects a null). No generic "updated"
 * timestamp exists on a return the way SaleOrder/SaleOrderItem have
 * CreatedOn/UpdatedOn — returnDeliveryDate/returnCompletedDate are
 * milestone-specific instead, not modeled as a single column here; `raw`
 * carries them if ever needed.
 */
export async function getReturn(reversePickupCode: string): Promise<UniwareReturnDetail | null> {
  const data = await restCall("/services/rest/v1/oms/return/get", {
    reversePickupCode,
  });
  if (!data) return null;

  const orderValue = (data.returnSaleOrderValue && typeof data.returnSaleOrderValue === "object"
    ? (data.returnSaleOrderValue as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  return {
    reversePickupCode,
    saleOrderCode: textOrNull(orderValue.saleOrderCode),
    returnAwb: textOrNull(orderValue.trackingNumber),
    status: textOrNull(orderValue.returnStatus),
    createdOn: textOrNull(orderValue.returnCreatedDate),
    updatedOn: null,
    raw: data,
  };
}
