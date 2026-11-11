import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
  pages: {
    signIn: '/login',
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOnLogin = nextUrl.pathname.startsWith('/login');

      if (isOnLogin) {
        if (isLoggedIn) {
          return Response.redirect(new URL('/', nextUrl));
        }
        return true;
      }

      // If user is not logged in, redirect them to /login with a clean relative callbackUrl
      if (!isLoggedIn) {
        const loginUrl = new URL('/login', nextUrl);
        const target = nextUrl.pathname + nextUrl.search;
        // Only set callbackUrl if accessing an actual page beyond home or login
        if (target && target !== '/' && !target.startsWith('/login')) {
          loginUrl.searchParams.set('callbackUrl', target);
        }
        return Response.redirect(loginUrl);
      }

      return true;
    },
    redirect({ url, baseUrl }) {
      const canonicalBase = (process.env.AUTH_URL || 'https://trading.jarengjar.com').replace(/\/$/, '');
      // If relative URL (e.g. "/" or "/stock/AAPL"), prepend canonicalBase so client new URL() parses safely
      if (url.startsWith('/')) {
        return `${canonicalBase}${url}`;
      }
      try {
        const parsed = new URL(url);
        // If redirect URL points to internal localhost/127.0.0.1, rewrite to canonicalBase
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
          return `${canonicalBase}${parsed.pathname}${parsed.search}`;
        }
        // If redirect URL matches canonicalBase or baseUrl, allow it
        if (parsed.origin === canonicalBase || parsed.origin === baseUrl) {
          return url;
        }
        return canonicalBase;
      } catch {
        return canonicalBase;
      }
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  providers: [],
  trustHost: true,
} satisfies NextAuthConfig;

