/** Minimal RFC 4180 CSV parsing, plus the cart-item mapping used by `fabplane carts import`. */
import type { CartItemInput } from "./types.js";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const s = Array.isArray(value) ? value.join(" ") : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER_ALIASES: Record<string, keyof CartItemInput> = {
  kind: "kind",
  mpn: "mpn",
  "manufacturer part number": "mpn",
  "part number": "mpn",
  manufacturer: "manufacturer",
  mfr: "manufacturer",
  description: "description",
  value: "value",
  footprint: "footprint",
  package: "footprint",
  refs: "refs",
  designator: "refs",
  designators: "refs",
  reference: "refs",
  references: "refs",
  quantity: "quantity",
  qty: "quantity",
  destination: "destinationId",
  destinationid: "destinationId",
  sku: "sku",
  "lcsc part": "sku",
  lcsc: "sku",
  url: "url",
  unitprice: "unitPrice",
  "unit price": "unitPrice",
  price: "unitPrice",
  currency: "currency",
  status: "status",
  notes: "notes",
  inventoryitemid: "inventoryItemId",
};

/**
 * Turns CSV rows (header first) into cart items. Headers are matched case-insensitively and
 * accept common BOM aliases (qty, designator, mfr, LCSC Part…); unknown columns are ignored.
 * `refs` splits on commas, spaces or semicolons. Rows without a quantity default to the ref count.
 */
export function cartItemsFromCsv(text: string): CartItemInput[] {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) return [];
  const keys = header.map((h) => HEADER_ALIASES[h.trim().toLowerCase()]);
  if (!keys.includes("quantity") && !keys.includes("refs")) {
    throw new Error("CSV needs a quantity (or qty) column, or a refs/designator column to count");
  }
  return rows.map((cells, n) => {
    const item: Record<string, unknown> = {};
    keys.forEach((key, i) => {
      const raw = cells[i]?.trim();
      if (!key || raw === undefined || raw === "") return;
      if (key === "refs") item["refs"] = raw.split(/[\s,;]+/).filter(Boolean);
      else if (key === "quantity" || key === "unitPrice") {
        const num = Number(raw);
        if (!Number.isFinite(num)) throw new Error(`Row ${n + 2}: ${key} "${raw}" is not a number`);
        item[key] = num;
      } else item[key] = raw;
    });
    if (item["quantity"] === undefined) item["quantity"] = Array.isArray(item["refs"]) ? item["refs"].length : 1;
    return item as CartItemInput;
  });
}

/** Accepts `[...]`, `{ items: [...] }` or JSONL of cart items. */
export function cartItemsFromJson(text: string): CartItemInput[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const v = JSON.parse(trimmed) as unknown;
      if (Array.isArray(v)) return v as CartItemInput[];
      if (v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items)) return (v as { items: CartItemInput[] }).items;
    } catch {
      /* fall through to JSONL */
    }
  }
  return parseJsonl<CartItemInput>(trimmed);
}

export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("//")) return;
    try {
      out.push(JSON.parse(t) as T);
    } catch (err) {
      throw new Error(`Line ${i + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
  });
  return out;
}
