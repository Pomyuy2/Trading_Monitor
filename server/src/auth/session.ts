import { decode } from '@auth/core/jwt';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Extracts and decodes the Auth.js session token from the Cookie header.
 * Supports both standard and chunked session cookies in HTTPS and HTTP modes.
 */
export async function getAuthUserFromCookie(
  cookieHeader: string | undefined,
  secret: string | undefined,
): Promise<AuthUser | null> {
  if (!cookieHeader || !secret) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    }),
  );

  let token = cookies['__Secure-authjs.session-token'] || cookies['authjs.session-token'];
  let salt = cookies['__Secure-authjs.session-token'] ? '__Secure-authjs.session-token' : 'authjs.session-token';

  // Handle chunked cookies if present
  if (!token) {
    const isSecure = Boolean(cookies['__Secure-authjs.session-token.0']);
    const isPlain = Boolean(cookies['authjs.session-token.0']);
    if (isSecure || isPlain) {
      const prefix = isSecure ? '__Secure-authjs.session-token' : 'authjs.session-token';
      salt = prefix;
      const chunks: string[] = [];
      for (let i = 0; ; i++) {
        const val = cookies[`${prefix}.${i}`];
        if (!val) break;
        chunks.push(val);
      }
      if (chunks.length > 0) token = chunks.join('');
    }
  }

  if (!token) return null;

  try {
    const payload = await decode({ token, secret, salt });
    const id = (payload?.id as string) || (payload?.sub as string);
    if (!id) return null;

    return {
      id,
      email: (payload?.email as string) || '',
      name: (payload?.name as string) || null,
    };
  } catch {
    return null;
  }
}
