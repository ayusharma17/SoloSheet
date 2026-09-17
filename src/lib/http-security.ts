const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function getTrustedAppOrigin(): string {
  const configured = process.env.APP_URL?.trim();
  if (!configured) throw new Error("APP_URL is not configured");

  const url = new URL(configured);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_URL must be an origin without credentials, query, or hash");
  }
  if (url.protocol !== "https:" &&
      !(process.env.NODE_ENV === "development" && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error("APP_URL must use HTTPS outside local development");
  }
  return url.origin;
}

export function internalRedirectPath(value: string | null, fallback = "/dashboard"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    return fallback;
  }
  return value;
}

function equivalentOrigin(candidate: URL, expected: URL): boolean {
  if (candidate.origin === expected.origin) return true;
  return process.env.NODE_ENV === "development" &&
    candidate.protocol === expected.protocol &&
    candidate.port === expected.port &&
    LOOPBACK_HOSTS.has(candidate.hostname) &&
    LOOPBACK_HOSTS.has(expected.hostname);
}

export function isSameOriginRequest(request: Request, trustedOrigin = getTrustedAppOrigin()): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const candidate = new URL(origin);
    const expected = new URL(trustedOrigin);
    if (!equivalentOrigin(candidate, expected)) return false;
    const fetchSite = request.headers.get("sec-fetch-site");
    return fetchSite === null || fetchSite === "same-origin";
  } catch {
    return false;
  }
}

export function trustedRedirectOrigin(request: Request, trustedOrigin = getTrustedAppOrigin()): string {
  const expected = new URL(trustedOrigin);
  if (process.env.NODE_ENV !== "development") return expected.origin;
  try {
    const candidate = new URL(request.url);
    return equivalentOrigin(candidate, expected) ? candidate.origin : expected.origin;
  } catch {
    return expected.origin;
  }
}

export type SafeLogDetails = Record<string, string | number | boolean | null | undefined>;

export function safeServerLog(scope: string, message: string, details: SafeLogDetails = {}): void {
  const sanitized = Object.fromEntries(
    Object.entries(details).filter(([, value]) =>
      value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value)),
  );
  console.error(JSON.stringify({ scope, message, ...sanitized }));
}
