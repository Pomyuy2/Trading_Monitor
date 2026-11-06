import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// The browser only ever talks to our own Fastify server (proxied here), never to data providers.
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  transpilePackages: ['@tm/shared'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
};

export default withNextIntl(config);
