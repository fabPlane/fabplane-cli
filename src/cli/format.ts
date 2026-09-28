/** Plain-text tables for human CLI output. */

export function table(rows: Array<Record<string, unknown>>, columns: Array<[key: string, label: string]>): string {
  if (rows.length === 0) return "(none)";
  const cells = rows.map((r) => columns.map(([k]) => cell(r[k])));
  const widths = columns.map(([, label], i) => Math.max(label.length, ...cells.map((c) => (c[i] ?? "").length)));
  const line = (vals: string[]) => vals.map((v, i) => (i === vals.length - 1 ? v : v.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  return [line(columns.map(([, label]) => label.toUpperCase())), ...cells.map(line)].join("\n");
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.join(",");
  if (typeof v === "boolean") return v ? "yes" : "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).replace(/\s+/g, " ");
}

export function keyValues(pairs: Array<[string, unknown]>): string {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${`${k}:`.padEnd(width + 2)}${cell(v)}`)
    .join("\n");
}
