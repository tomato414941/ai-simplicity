import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { transform } from "esbuild";
import { createClient } from "@supabase/supabase-js";

test("the shipped native bridge makes Supabase use secure random PKCE with S256", async (t) => {
  const source = await readFile(new URL("../src/crypto.ts", import.meta.url), "utf8");
  const compiled = await transform(source, { loader: "ts", format: "cjs" });
  let randomCalls = 0, digestCalls = 0;
  const context = { require: () => ({
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    getRandomValues(array: Uint32Array) { randomCalls++; return webcrypto.getRandomValues(array); },
    randomUUID: () => webcrypto.randomUUID(),
    digest(algorithm: string, data: BufferSource) { digestCalls++; return webcrypto.subtle.digest(algorithm, data); },
  }) } as any;
  runInNewContext(compiled.code, context);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: context.crypto });
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  const saved = new Map<string, string>();
  let request: any;
  const { auth } = createClient("https://auth.example.test", "publishable-test", {
    auth: { flowType: "pkce", persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
      storage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: (key) => { saved.delete(key); } },
    },
    global: { fetch: async (_url, options) => { request = JSON.parse(String(options?.body)); return Response.json({}); } },
  });
  const { error } = await auth.signInWithOtp({ email: "test@example.com", options: { shouldCreateUser: false, emailRedirectTo: "aisimplicity://auth/callback" } });
  assert.equal(error, null);
  assert.equal(request.code_challenge_method, "s256");
  assert.ok(randomCalls > 0);
  assert.equal(digestCalls, 1);
  const verifier = JSON.parse([...saved.values()][0]);
  const expected = Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  assert.equal(request.code_challenge, expected);
  await assert.rejects(context.crypto.subtle.digest("MD5", new Uint8Array()), /Unsupported digest/);
});
