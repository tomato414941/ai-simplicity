import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { Foundation } from "../src/foundation.js";
import { UserSessions } from "../src/user-sessions.js";
import { app, authFetch, session, USER_A } from "./helpers.js";

// Foundation, played by a local server: it remembers what it was asked and answers as the real one does.
async function fakeFoundation(t) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: body ? JSON.parse(body) : null });
    const reply = (status, data) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    if (request.headers.authorization !== "Bearer fdni_test") return reply(401, { error: { code: "not_an_integration" } });
    if (request.method === "PUT" && /^\/v1\/integration\/accounts\/[^/]+$/.test(request.url)) return reply(200, { account: { id: "acct-1" } });
    if (request.method === "POST" && request.url.endsWith("/keys")) return reply(201, { key: { id: "key-" + calls.length, name: "ai-simplicity", token: "fdn_" + "x".repeat(43) } });
    if (request.method === "DELETE" && request.url.includes("/keys/")) return reply(200, { ok: true });
    if (request.method === "POST" && request.url === "/v1/integration/links") {
      const { request_id, external_id } = calls.at(-1).body;
      if (external_id !== USER_A) return reply(404, { error: { code: "not_found" } });
      return reply(201, { url: "http://foundation.test/requests/" + request_id + "#link=abc" });
    }
    reply(404, { error: { code: "not_found" } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  return { calls, url, foundation: new Foundation({ url, integrationKey: "fdni_test", webhookSecret: "whsec_test" }) };
}
const requestId = "A".repeat(43);

test("creating a conversation gives it a key to the user's Foundation account over MCP, replacing the previous one", async (t) => {
  const { calls, foundation, url } = await fakeFoundation(t);
  const keys = new Map([["user", "key-old"]]), created = [];
  const client = { beta: { agents: { sessions: { create: async (body) => { created.push(body); return session(); } } } } };
  const store = { read: async () => null, write: async () => {} };
  foundation.keys = { read: async (id) => keys.get(id) ?? null, write: async (id, keyId) => keys.set(id, keyId) };
  const sessions = new UserSessions({ client, model: "gpt-6-astra", store, tools: [foundation] });
  await sessions.create("user", sessions.defaults);
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [["PUT", "/v1/integration/accounts/user"], ["POST", "/v1/integration/accounts/user/keys"]]);
  assert.equal(calls[1].body.replaces, "key-old", "the previous conversation's key is revoked with the new one");
  const tool = created[0].agent.tools.find((item) => item.type === "mcp");
  assert.equal(tool.transport.server_url, url + "/mcp");
  assert.match(tool.transport.authorization, /^Bearer fdn_/);
  assert.match(created[0].agent.instructions, /foundation_guide/);
  assert.equal(keys.get("user"), "key-2", "only the key's id is kept here");
  assert.doesNotMatch(JSON.stringify([...keys]), /fdn_/);
});

test("a conversation that cannot be created leaves no live key behind", async (t) => {
  const { calls, foundation } = await fakeFoundation(t);
  const client = { beta: { agents: { sessions: { create: async () => { throw Object.assign(new Error("upstream"), { status: 503 }); } } } } };
  foundation.keys = { read: async () => null, write: async () => { throw new Error("must not be reached"); } };
  const sessions = new UserSessions({ client, model: "gpt-6-astra", store: { read: async () => null, write: async () => {} }, tools: [foundation] });
  await assert.rejects(sessions.create("user", sessions.defaults));
  assert.equal(calls.at(-1).method, "DELETE"); assert.match(calls.at(-1).path, /\/keys\/key-2$/);
});

test("without Foundation configured, conversations are created exactly as before", async () => {
  const created = [];
  const client = { beta: { agents: { sessions: { create: async (body) => { created.push(body); return session(); } } } } };
  const sessions = new UserSessions({ client, model: "gpt-6-astra", store: { read: async () => null, write: async () => {} } });
  await sessions.create("user", sessions.defaults);
  assert.deepEqual(created[0].agent.tools, [{ type: "web_search", mode: "live" }]);
  assert.doesNotMatch(created[0].agent.instructions, /foundation/i);
});

test("opening a request asks Foundation for a single-use link in this user's name; a signed notice is accepted and a forged one is not", async (t) => {
  const { calls, foundation } = await fakeFoundation(t);
  const { base } = await app(t, async () => { throw new Error("no upstream call expected"); }, { foundation });
  const linked = await authFetch(base + "/api/foundation/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: requestId }) });
  const answer = await linked.text();
  assert.equal(linked.status, 200, answer);
  assert.equal(JSON.parse(answer).url, "http://foundation.test/requests/" + requestId + "#link=abc");
  assert.deepEqual(calls.at(-1).body, { request_id: requestId, external_id: USER_A });
  const other = await fetch(base + "/api/foundation/links", { method: "POST", headers: { Authorization: "Bearer user-b", "content-type": "application/json" }, body: JSON.stringify({ request_id: requestId }) });
  assert.equal(other.status, 404, "Foundation refuses a request that is not that user's, and so do we");
  assert.equal((await fetch(base + "/api/foundation/links", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await authFetch(base + "/api/foundation/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: "../x" }) })).status, 404);
  const body = JSON.stringify({ id: "evt_1", type: "request.done", created: 1, account: USER_A, data: {} });
  const at = Math.floor(Date.now() / 1000);
  const signature = `t=${at},v1=${createHmac("sha256", "whsec_test").update(at + "." + body).digest("hex")}`;
  assert.equal((await fetch(base + "/api/foundation/events", { method: "POST", headers: { "content-type": "application/json", "foundation-signature": signature }, body })).status, 204);
  assert.equal((await fetch(base + "/api/foundation/events", { method: "POST", headers: { "content-type": "application/json", "foundation-signature": signature }, body: body + " " })).status, 401);
  assert.equal((await fetch(base + "/api/foundation/events", { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
  const stale = at - 600;
  assert.equal((await fetch(base + "/api/foundation/events", { method: "POST", headers: { "content-type": "application/json", "foundation-signature": `t=${stale},v1=${createHmac("sha256", "whsec_test").update(stale + "." + body).digest("hex")}` }, body })).status, 401);
});

test("the Foundation page is served, and the links route is absent when Foundation is not configured", async (t) => {
  const { base } = await app(t, async () => { throw new Error("no upstream call expected"); });
  assert.equal((await fetch(base + "/foundation?foundation_request=" + requestId)).status, 200);
  assert.equal((await authFetch(base + "/api/foundation/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: requestId }) })).status, 404);
});

test("a Responses request to the managed OpenAI model carries this user's Foundation connection; the key never comes back", async (t) => {
  const { calls, foundation, url } = await fakeFoundation(t);
  const foundationKeys = new Map([[USER_A, "key-old"]]);
  const echoed = { id: "resp_a", object: "response", created_at: 1, status: "completed", model: "gpt-6-astra", output: [], usage: { input_tokens: 1, output_tokens: 1 },
    tools: [{ type: "web_search" }, { type: "mcp", server_label: "foundation", server_url: url + "/mcp", authorization: "Bearer fdn_" + "x".repeat(43) }] };
  const { base, requests } = await app(t, () => Response.json(echoed), { foundation, foundationKeys });
  const body = JSON.stringify({ model: "gpt-6-astra", input: "hi", tools: [{ type: "web_search" }], instructions: "Be brief." });
  const create = async () => authFetch(base + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body });
  const first = await (await create()).json();
  const sent = requests.at(-1).body;
  const tool = sent.tools.find((item) => item.type === "mcp");
  assert.equal(tool.server_url, url + "/mcp"); assert.match(tool.authorization, /^Bearer fdn_/); assert.equal(tool.require_approval, "never");
  assert.match(sent.instructions, /^Be brief\./); assert.match(sent.instructions, /foundation_guide/);
  assert.deepEqual(first.tools.find((item) => item.type === "mcp"), { type: "mcp", server_label: "foundation", server_url: url + "/mcp" }, "what comes back is redacted");
  assert.doesNotMatch(JSON.stringify(first), /fdn_/);
  await create();
  assert.equal(calls.filter((call) => call.path.endsWith("/keys")).length, 1, "one key per user, issued once and reused");
  assert.equal(calls.find((call) => call.path.endsWith("/keys")).body.replaces, "key-old");
  assert.equal(foundationKeys.get(USER_A), "key-2");
});

test("a Responses request to another provider carries no Foundation connection", async (t) => {
  const { calls, foundation } = await fakeFoundation(t);
  const { base, requests } = await app(t, () => Response.json({ id: "resp_r", object: "response", created_at: 1, status: "completed", model: "router", output: [], usage: {} }), { foundation });
  const models = await (await authFetch(base + "/v1/models")).json();
  const routed = models.data.find((item) => item.owned_by !== "openai");
  if (!routed) return;
  await authFetch(base + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: routed.id, input: "hi" }) });
  assert.equal((requests.at(-1).body.tools ?? []).some((item) => item.type === "mcp"), false);
  assert.equal(calls.length, 0);
});

test("a source's grant is spelled by whichever provider carries it, and a provider that cannot carry it drops the instructions with it", async () => {
  const { grant } = await import("../src/tools.js");
  const { NativeResponses } = await import("../src/response-providers.js");
  const { AnthropicResponses } = await import("../src/anthropic-responses.js");
  const { carry: agents } = await import("../src/agent-session.js");
  const kept = [];
  const source = { grant: async (userId) => ({ tools: [{ kind: "mcp", label: "vault", url: "https://vault.test/mcp", token: "fdn_t", instructions: "\nUse vault." }], keep: async () => kept.push(userId) }) };
  const granted = await grant([source], "user");
  const params = { model: "m", instructions: "Be brief.", tools: [{ type: "web_search" }] };
  const managed = new NativeResponses({ responses: {} }, true).carry(params, granted.tools);
  assert.deepEqual(managed.tools.at(-1), { type: "mcp", server_label: "vault", server_url: "https://vault.test/mcp", authorization: "Bearer fdn_t", require_approval: "never" });
  assert.equal(managed.instructions, "Be brief.\nUse vault.");
  assert.deepEqual(new NativeResponses({ responses: {} }, false).carry(params, granted.tools), params);
  assert.deepEqual(new AnthropicResponses({ apiKey: "k" }).carry(params, granted.tools), params);
  assert.deepEqual(agents([{ kind: "web_search" }, ...granted.tools]), { tools: [{ type: "web_search", mode: "live" }, { type: "mcp", server_label: "vault", transport: { type: "http", server_url: "https://vault.test/mcp", authorization: "Bearer fdn_t" } }], instructions: "\nUse vault." });
  await granted.keep();
  assert.deepEqual(kept, ["user"]);
  assert.deepEqual(await grant([], "user").then((empty) => empty.tools), []);
});
