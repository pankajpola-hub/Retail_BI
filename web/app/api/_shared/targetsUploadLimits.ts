import "server-only";

/**
 * File limits for the targets workbook uploads. Defined once here and
 * imported by BOTH app/api/targets/upload (which originally declared them)
 * and app/api/targets/monthly/bulk-preview (audit B-09: the only upload
 * route in the tree with neither a size cap nor a MIME check — it called
 * file.arrayBuffer() on an unbounded body).
 *
 * NOT the same pair as app/api/data-upload/upload-url's 50MB ERP-report cap
 * — that one covers multi-year merged ERP exports going direct to Storage;
 * a targets workbook is a store x month grid and never approaches 10MB.
 */
export const TARGETS_MAX_BYTES = 10 * 1024 * 1024; // 10MB
export const TARGETS_ALLOWED_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
];
