import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { createAuthenticator } from "../src/auth.js";
import { SupabaseSessionStore } from "../src/user-sessions.js";
import { USER_A } from "./helpers.js";

const url = "https://auth-test.supabase.co";
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "ES256", use: "sig" };
const claims = () => ({ sub: USER_A, iss: url + "/auth/v1", aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 60, is_anonymous: true });
const jwt = (payload, key = pair.privateKey) => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${part({ alg: "ES256", kid: jwk.kid, typ: "JWT" })}.${part(payload)}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};

test("real Supabase SDK verifies signatures and caches signing keys; email linking keeps the same identity", async () => {
  let requests = 0;
  const { auth } = createClient(url, "sb_publishable_test", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (path) => {
      assert.equal(path, url + "/auth/v1/.well-known/jwks.json");
      requests++;
      return Response.json({ keys: [jwk] });
    } },
  });
  const authenticate = createAuthenticator({ auth, url });
  const run = (token) => authenticate({ headers: { authorization: `Bearer ${token}` } });
  assert.equal((await run(jwt(claims()))).id, USER_A);
  assert.equal((await run(jwt({ ...claims(), is_anonymous: false, email: "person@example.com" }))).id, USER_A);
  assert.equal(requests, 1);
  const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  for (const token of ["not-a-jwt", jwt(claims(), otherKey), jwt({ ...claims(), exp: 1 }),
    jwt({ ...claims(), iss: "https://foreign.example/auth/v1" }), jwt({ ...claims(), aud: "service_role" }),
    jwt({ ...claims(), role: "service_role" }), jwt({ ...claims(), role: "anon" }), jwt({ ...claims(), sub: "" }),
    jwt({ ...claims(), nbf: Math.floor(Date.now() / 1000) + 600 })]) {
    await assert.rejects(run(token), { status: 401 });
  }
  await assert.rejects(authenticate({ headers: {} }), { status: 401 });
});

test("auth outages fail closed without turning into a new anonymous account", async () => {
  for (const auth of [
    { getClaims: async () => { throw new Error("Private infrastructure diagnostic"); } },
    { getClaims: async () => ({ error: { status: 503 } }) },
    { getClaims: async () => ({ error: { name: "AuthRetryableFetchError" } }) },
  ]) {
    const authenticate = createAuthenticator({ auth, url });
    await assert.rejects(authenticate({ headers: { authorization: "Bearer credential" } }), { status: 503 });
  }
});

test("ownership storage always filters by verified user ID and never upserts another binding", async () => {
  const requests = [];
  const database = createClient(url, "sb_secret_test", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (path, options) => {
      requests.push({ url: new URL(path), options });
      return options.method === "POST" ? new Response(null, { status: 201 }) : Response.json({ session_id: "sess_test" });
    } },
  });
  const store = new SupabaseSessionStore(database);
  assert.equal(await store.read(USER_A), "sess_test");
  assert.equal(requests[0].url.searchParams.get("user_id"), `eq.${USER_A}`);
  assert.equal(requests[0].url.searchParams.get("select"), "session_id");
  await store.write(USER_A, "sess_test");
  assert.deepEqual(JSON.parse(requests[1].options.body), { user_id: USER_A, session_id: "sess_test" });
  assert.doesNotMatch(new Headers(requests[1].options.headers).get("prefer") ?? "", /resolution/);
});
