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
