/**
 * Obfuscate/encode sensitive credential payloads before network transit.
 * Prefixed with `b64:` so receivers can distinguish encoded values from plain strings.
 * Uses standard Web APIs (TextEncoder, TextDecoder, btoa, atob) compatible with both
 * browsers and Node.js environments.
 */
export function encodePayload(value: string): string {
  if (!value) return '';
  try {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return 'b64:' + btoa(binary);
  } catch {
    return value;
  }
}

/**
 * Decode payload encoded with `encodePayload`. If input is not encoded (e.g. legacy/direct),
 * it returns the original string.
 */
export function decodePayload(value: string): string {
  if (!value || typeof value !== 'string') return '';
  if (!value.startsWith('b64:')) return value;
  try {
    const binary = atob(value.slice(4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}
