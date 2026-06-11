// 16-char Crockford base32 page id (file.md §Frontmatter, mirrors
// server-rs/src/frontmatter.rs). 80 bits of entropy; non-crypto RNG
// is fine because uniqueness is checked vault-wide on PUT.

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newPageId(): string {
  const bytes = new Uint8Array(10);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 10; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < 16; i++) {
    const bit = i * 5;
    const byte = bit >> 3;
    const off = bit & 7;
    const hi = bytes[byte] << 8;
    const lo = byte + 1 < bytes.length ? bytes[byte + 1] : 0;
    const idx = ((hi | lo) >> (11 - off)) & 0x1f;
    out += ID_ALPHABET[idx];
  }
  return out;
}
