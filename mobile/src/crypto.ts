import { CryptoDigestAlgorithm, digest, getRandomValues, randomUUID } from "expo-crypto";
import { fromByteArray } from "base64-js";

// Hermes does not supply the binary-string Base64 function used by PKCE.
globalThis.btoa = (value: string) => fromByteArray(Uint8Array.from(value, (character) => {
  const byte = character.charCodeAt(0);
  if (byte > 255) throw new TypeError("btoa requires a binary string");
  return byte;
}));

// Supabase's PKCE needs these Web Crypto methods. Delegate to the OS via Expo;
// without this bridge the SDK falls back to Math.random() and a plain challenge.
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: {
    getRandomValues, randomUUID,
    subtle: {
      digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
        const name = typeof algorithm === "string" ? algorithm : algorithm.name;
        if (name.toUpperCase() !== "SHA-256") return Promise.reject(new Error("Unsupported digest"));
        return digest(CryptoDigestAlgorithm.SHA256, data);
      },
    },
  },
});
