/**
 * Base64url <-> Uint8Array helpers. RN doesn't ship Buffer; both `atob`/`btoa`
 * are available globally on RN (and browsers), and JS engines expose
 * String.fromCharCode for byte ↔ char conversions.
 *
 * No padding in base64url output.
 */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i] as number);
  }
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url + "===".slice(0, (4 - (b64url.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
