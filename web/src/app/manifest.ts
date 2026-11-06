import type { MetadataRoute } from 'next';

/** Web app manifest: installable on phone (Add to Home Screen) and desktop (Install app). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Trading Monitor',
    short_name: 'Trading',
    description: 'Personal stock monitor: live prices, chart, levels, news, insight and alerts (EN/TH).',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0B0E13',
    theme_color: '#0B0E13',
    categories: ['finance'],
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/512?maskable=1', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
