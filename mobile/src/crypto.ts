import { CryptoDigestAlgorithm, digest, getRandomValues, randomUUID } from "expo-crypto";

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
