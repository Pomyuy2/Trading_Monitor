import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// The browser only ever talks to our own Fastify server (proxied here), never to data providers.
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  // The Playwright smoke test runs its own next dev; a separate folder avoids clashing with yours.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  transpilePackages: ['@tm/shared'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
};

export default withNextIntl(config);
