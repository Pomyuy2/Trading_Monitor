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
      // Always allow and return relative paths (e.g. "/" or "/stock/AAPL")
      if (url.startsWith('/')) {
        return url;
      }
      try {
        const parsed = new URL(url);
        // If redirect URL matches baseUrl or internal localhost/domain, normalize to relative path
        if (
          parsed.origin === baseUrl ||
          parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname === 'trading.jarengjar.com'
        ) {
          return parsed.pathname + parsed.search || '/';
        }
        return url;
      } catch {
        return '/';
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

