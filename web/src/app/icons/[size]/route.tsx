import { ImageResponse } from 'next/og';

const SIZES = new Set([180, 192, 512]);

/** App icons drawn in code (no binary files in the repo). ?maskable=1 adds the safe-zone padding. */
export async function GET(req: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return new Response('Not found', { status: 404 });
  const maskable = new URL(req.url).searchParams.get('maskable') === '1';
  const glyph = Math.round(size * (maskable ? 0.5 : 0.62));
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0B0E13' }}>
        <div
          style={{
            width: maskable ? '100%' : '84%',
            height: maskable ? '100%' : '84%',
            borderRadius: maskable ? 0 : size * 0.2,
            background: '#2B5BC4',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 17l5-5 4 3 9-9" />
            <path d="M15 6h6v6" />
          </svg>
        </div>
      </div>
    ),
    { width: size, height: size, headers: { 'Cache-Control': 'public, max-age=86400' } },
  );
}
