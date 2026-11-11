import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for GCM

function getEncryptionKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret || 'default-fallback-secret-key-32b').digest();
}

function getHmacKey(secret: string): Buffer {
  return crypto.createHmac('sha256', secret || 'default-fallback-secret-key-32b').update('email-blind-index').digest();
}

/**
 * Compute an HMAC-SHA256 blind index for deterministic exact-match search on encrypted emails.
 */
export function computeEmailHash(email: string, secret: string = process.env.AUTH_SECRET || ''): string {
  const normalized = email.trim().toLowerCase();
  return crypto.createHmac('sha256', getHmacKey(secret)).update(normalized).digest('hex');
}

/**
 * Encrypt email using AES-256-GCM with a random IV.
 * Format: `enc:<iv_hex>:<tag_hex>:<ciphertext_hex>`
 */
export function encryptEmail(email: string, secret: string = process.env.AUTH_SECRET || ''): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.startsWith('enc:')) {
    // Already encrypted
    return normalized;
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt email stored as `enc:<iv_hex>:<tag_hex>:<ciphertext_hex>`.
 * If value is not encrypted (e.g. legacy/plaintext), returns original string safely.
 */
export function decryptEmail(stored: string, secret: string = process.env.AUTH_SECRET || ''): string {
  if (!stored || !stored.startsWith('enc:')) {
    return stored || '';
  }
  try {
    const parts = stored.split(':');
    if (parts.length !== 4) return stored;
    const [, ivHex, tagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(secret), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return stored;
  }
}
