import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Thai, Inter, JetBrains_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { PwaSetup } from '@/components/PwaSetup';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const thai = IBM_Plex_Sans_Thai({ subsets: ['thai', 'latin'], weight: ['400', '500', '600', '700'], variable: '--font-thai', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return {
    title: t('title'),
    applicationName: t('title'),
    appleWebApp: { capable: true, title: t('title'), statusBarStyle: 'black-translucent' },
    icons: { icon: '/icons/192', apple: '/icons/180' },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const light = (await cookies()).get('tm_theme')?.value === 'light';
  return { themeColor: light ? '#F4F6F9' : '#0B0E13', width: 'device-width', initialScale: 1, viewportFit: 'cover' };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  // Theme comes from a cookie so the server renders the right colors (no flash).
  const theme = (await cookies()).get('tm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <html lang={locale} data-theme={theme} className={`${inter.variable} ${thai.variable} ${mono.variable}`}>
      <body className="min-h-dvh">
        <NextIntlClientProvider>
          {children}
          <PwaSetup />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
