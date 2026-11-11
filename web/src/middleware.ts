import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

export default NextAuth(authConfig).auth;

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt
     * - manifest.json, icons, img
     */
    '/((?!api|_next/static|_next/image|favicon.ico|manifest.json|icons|img|robots.txt|sitemap.xml).*)',
  ],
};
