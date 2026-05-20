/** @type {import('next').NextConfig} */
const MODAL_URL = "https://razornne--transcriptor-v2-flask-app.modal.run";

const nextConfig = {
  // Прокси для backend и текущего /app фронта на Modal.
  // Когда фронт /app переедет в этот же проект как статика — уберём app-прокси.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${MODAL_URL}/api/:path*` },
      { source: "/app",         destination: `${MODAL_URL}/` },
      { source: "/app/:path*",  destination: `${MODAL_URL}/:path*` },
    ];
  },
};

export default nextConfig;
