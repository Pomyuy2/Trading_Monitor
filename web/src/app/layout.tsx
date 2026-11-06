import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Thai, Inter, JetBrains_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const thai = IBM_Plex_Sans_Thai({ subsets: ['thai', 'latin'], weight: ['400', '500', '600', '700'], variable: '--font-thai', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('title') };
}

export const viewport: Viewport = {
  themeColor: '#0B0E13',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${inter.variable} ${thai.variable} ${mono.variable}`}>
      <body className="min-h-dvh">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
