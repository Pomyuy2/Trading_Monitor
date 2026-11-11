import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authConfig } from './auth.config';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4000';

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  session: {
    strategy: 'jwt',
  },
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials) => {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = String(credentials.email).trim().toLowerCase();
        const password = String(credentials.password);

        // 1. Verify against Fastify internal endpoint (connected to SQLite User table)
        try {
          const res = await fetch(`${API_URL}/api/internal/auth/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password }),
            signal: AbortSignal.timeout(5000),
          });

          if (res.ok) {
            const data = (await res.json()) as { ok: boolean; user?: { id: string; email: string; name: string | null } };
            if (data.ok && data.user) {
              return {
                id: data.user.id,
                email: data.user.email,
                name: data.user.name ?? data.user.email.split('@')[0],
              };
            }
          }
        } catch {
          // Continue to env check fallback if Fastify is booting or unreachable
        }

        // 2. Fallback to environment variables (only if explicitly configured)
        const envEmail = process.env.AUTH_USER_EMAIL?.trim().toLowerCase();
        const envPass = process.env.AUTH_USER_PASSWORD;

        if (envEmail && envPass && email === envEmail && password === envPass) {
          return {
            id: 'admin-env',
            email: envEmail,
            name: 'Admin',
          };
        }

        return null;
      },
    }),
  ],
});
