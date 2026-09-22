import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function localSupabaseConnectSources(
  development: boolean,
  configuredUrl: string | undefined,
): string[] {
  if (!development || !configuredUrl) return [];
  try {
    const url = new URL(configuredUrl);
    if (!loopbackHosts.has(url.hostname) || !["http:", "https:"].includes(url.protocol)) return [];
    const socketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    return [url.origin, `${socketProtocol}//${url.host}`];
  } catch {
    return [];
  }
}

const connectSources = [
  "'self'",
  "https://*.supabase.co",
  "wss://*.supabase.co",
  ...localSupabaseConnectSources(isDevelopment, process.env.NEXT_PUBLIC_SUPABASE_URL),
];
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com",
  "font-src 'self' data:",
  `connect-src ${connectSources.join(" ")}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    // Next 16.3's Turbopack build cache can serialize server-only environment
    // values into .next/cache. Netlify scans that generated cache as build
    // output, so keep production filesystem caching disabled.
    turbopackFileSystemCacheForBuild: false,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
