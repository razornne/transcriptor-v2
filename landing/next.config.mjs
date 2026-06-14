/** @type {import('next').NextConfig} */
const MODAL_URL = "https://razornne--transcriptor-v2-flask-app.modal.run";
// PostHog EU region. Reverse proxy через skriptly.io/ingest/* чтобы adblock'и
// (uBlock, AdGuard, Brave Shields) не блочили запросы — они режут *.posthog.com
// по умолчанию. First-party requests на свой домен они не трогают.
const POSTHOG_API    = "https://eu.i.posthog.com";
const POSTHOG_ASSETS = "https://eu-assets.i.posthog.com";

const nextConfig = {
  // skipTrailingSlashRedirect нужен для корректной работы PostHog API endpoints
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      // PostHog ingest — static assets и API endpoints. ВАЖНО: static ДО общего!
      { source: "/ingest/static/:path*", destination: `${POSTHOG_ASSETS}/static/:path*` },
      { source: "/ingest/:path*",        destination: `${POSTHOG_API}/:path*` },
      // Backend API (audio goes direct to Modal — bypasses 4MB Vercel edge limit)
      { source: "/api/:path*", destination: `${MODAL_URL}/api/:path*` },
    ];
  },
};

export default nextConfig;
