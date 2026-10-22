// The box's admin token, sealed at rest.
//
// AES-GCM-256, key = SHA-256(env secret). Stored form is base64(iv(12)
// ++ ciphertext). Decrypt only at call time (the mint, revoke, audit
// and box relays); heartbeat auth never consults it. Plaintext is never
// logged anywhere on this path.
//
// It lives here, not in the enrolment, because the enrolment and every
// relay that carries the token read it. The token is what they share,
// and a module that holds what they share is what keeps their imports a
// tree.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(raw: string): Uint8Array {
  const binary = atob(raw);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function importSealKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error("enroll: seal key not configured");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealAdminToken(secret: string, plaintext: string): Promise<string> {
  const key = await importSealKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return bytesToBase64(out);
}

// Returns null when no admin token was ever bound; throws on wrong key or
// tampered blob (callers treat that as a hard failure, never a fallback).
export async function unsealAdminToken(secret: string, sealed: string): Promise<string | null> {
  if (!sealed) {
    return null;
  }
  const key = await importSealKey(secret);
  const bytes = base64ToBytes(sealed);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return new TextDecoder().decode(pt);
}
