import { createHmac, timingSafeEqual } from "node:crypto";

// Foundation holds, for each of our users, what their agent needs but must not carry: keys, secrets,
// connections. We hold one integration credential; it makes accounts and their keys and hands a user
// to one request through a single-use link. It never reaches what an account keeps.
//
// This is the relationship only. How the agent's connection is spelled for a model provider is that
// provider's business (see tools.js); Foundation grants one row and knows no provider.
const KEY_NAME = "ai-simplicity";

const INSTRUCTIONS = `
The foundation MCP tools reach this person's Foundation account: keys, secrets and connections they keep for you.
Call foundation_guide before using it, and follow its rules. Never ask the person to paste a secret into the chat.`;

export class Foundation {
  constructor({ url, integrationKey, webhookSecret, keys = null, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.url = url ? new URL(url).origin : null;
    this.integrationKey = integrationKey ?? null;
    this.webhookSecret = webhookSecret ?? null;
    // Which key each user carries, by ID only. The secret itself lives in Foundation's hash and, in memory
    // here, for as long as this process runs. After a restart a new one is issued, and the previous one
    // (its ID is all that is stored) is revoked with it.
    this.keys = keys;
    this.cache = new Map();
    this.fetch = fetchImpl;
  }

  get enabled() { return Boolean(this.url && this.integrationKey); }

  // The one row this source grants: the agent's MCP connection to this user's account, carrying a key
  // that is kept once the request it was made for is in place, or revoked if that failed.
  async grant(userId) {
    const row = (token) => ({ kind: "mcp", label: "foundation", url: this.url + "/mcp", token, instructions: INSTRUCTIONS,
      description: "This person's Foundation account: keys, secrets and connections they keep for you. Call foundation_guide first." });
    if (this.cache.has(userId)) return { tools: [row(this.cache.get(userId))] };
    const key = await this.issueKey(userId, await this.keys.read(userId));
    return {
      tools: [row(key.token)],
      keep: async () => { await this.keys.write(userId, key.id); this.cache.set(userId, key.token); },
      drop: () => this.revokeKey(userId, key.id),
    };
  }

  async call(method, path, body) {
    const response = await this.fetch(this.url + path, {
      method, headers: { authorization: "Bearer " + this.integrationKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8_000),
    });
    const data = await response.json().catch(() => ({}));
    // What Foundation cannot find (a request that is not this user's, an account that is gone) is not found here either.
    if (response.status === 404) throw Object.assign(new Error("Unknown request."), { status: 404, local: true, code: "not_found" });
    if (!response.ok) throw Object.assign(new Error("Foundation is unavailable."), { status: 503, foundation: { status: response.status, code: data.error?.code } });
    return data;
  }

  // The user's account (made on first use), and a fresh key. The key it replaces is revoked in the same
  // call, so a rebuilt conversation never leaves an old key alive.
  async issueKey(userId, replaces) {
    await this.call("PUT", "/v1/integration/accounts/" + encodeURIComponent(userId), {});
    const { key } = await this.call("POST", "/v1/integration/accounts/" + encodeURIComponent(userId) + "/keys", { name: KEY_NAME, ...(replaces ? { replaces } : {}) });
    return key;
  }

  async revokeKey(userId, keyId) {
    await this.call("DELETE", "/v1/integration/accounts/" + encodeURIComponent(userId) + "/keys/" + encodeURIComponent(keyId), {});
  }

  // A single-use link to one of this user's requests, made only after we checked who is asking.
  async link(userId, requestId) {
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(requestId)) throw Object.assign(new Error("Unknown request."), { status: 404, local: true });
    const { url } = await this.call("POST", "/v1/integration/links", { request_id: requestId, external_id: userId });
    return url;
  }

  // Foundation-Signature: t=<seconds>,v1=<HMAC-SHA256 of "t.body"> with the secret shown once at registration.
  verify(signature, body, now = Date.now()) {
    if (!this.webhookSecret) return false;
    const match = String(signature ?? "").match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (!match) return false;
    const [, at, given] = match;
    if (Math.abs(now / 1000 - Number(at)) > 300) return false;
    const expected = createHmac("sha256", this.webhookSecret).update(at + "." + body).digest("hex");
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }
}

export class SupabaseFoundationKeyStore {
  constructor(client) { this.client = client; }
  async read(userId) {
    const { data, error } = await this.client.from("foundation_keys").select("key_id").eq("user_id", userId).maybeSingle();
    if (error) throw Object.assign(new Error("Key storage is unavailable."), { status: 503 });
    return data?.key_id ?? null;
  }
  async write(userId, keyId) {
    const { error } = await this.client.from("foundation_keys").upsert({ user_id: userId, key_id: keyId, updated_at: new Date().toISOString() });
    if (error) throw Object.assign(new Error("Could not save the key reference."), { status: 503 });
  }
}
