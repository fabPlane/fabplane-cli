/** The production API. Override with `FABPLANE_API_ORIGIN` or the client's `origin` option. */
export const DEFAULT_API_ORIGIN = "https://api.fabplane.com";

/** Drops trailing slashes; adds `https://` when the scheme is missing. */
export function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * The web dashboard that belongs to an API origin:
 * - `https://api.fabplane.com` → `https://app.fabplane.com/dashboard`
 * - `http(s)://<host>:4000` → `http(s)://<host>:5173/dashboard`
 * - `http://localhost:<port>` → `http://localhost:5173/dashboard`
 * - otherwise a leading `api.` in the host becomes `app.`
 */
export function dashboardUrlFor(apiOrigin: string = DEFAULT_API_ORIGIN): string {
  let url: URL;
  try {
    url = new URL(normalizeOrigin(apiOrigin));
  } catch {
    return "https://app.fabplane.com/dashboard";
  }
  const host = url.hostname.toLowerCase();
  if (host === "api.fabplane.com") return "https://app.fabplane.com/dashboard";
  if (url.port === "4000") return `${url.protocol}//${url.hostname}:5173/dashboard`;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return `${url.protocol}//${url.hostname}:5173/dashboard`;
  }
  const appHost = host.startsWith("api.") ? `app.${host.slice(4)}` : host;
  return `${url.protocol}//${appHost}${url.port ? `:${url.port}` : ""}/dashboard`;
}

