import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { createServer } from "../src/server.js";
import { app, session, page, messageEvent, USER_A, USER_B } from "./helpers.js";

const prefix = "/v1/agents/sessions";
const creation = { agent: { model: "gpt-6-astra" }, environment: { type: "openai_hosted" } };
const routes = [
  ["GET", prefix], ["POST", prefix, creation],
  ...["", "/items", "/turns", "/turns/turn_1", "/events"].map((path) => ["GET", prefix + "/sess_test" + path]),
  ["POST", prefix + "/sess_test/events", { events: [messageEvent()] }],
  ["POST", prefix + "/sess_test/events", { events: [{ type: "agent.session.input.cancel" }] }],
];
function request(base, token, method, path, body) {
  return fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}

test("every supported native endpoint requires authentication before accessing OpenAI", async (t) => {
  assert.throws(() => createServer({}), /Authentication/);
  const { base, requests } = await app(t, () => assert.fail("Must not reach OpenAI"));
  for (const token of [null, "invalid"]) for (const [method, path, body] of routes) {
    const response = await request(base, token, method, path, body);
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal((await response.json()).error.type, "authentication_error");
  }
  assert.equal(requests.length, 0);
  const config = await fetch(base + "/api/config").then((response) => response.json());
  assert.deepEqual(Object.keys(config.supabase), ["url", "publishableKey"]);
  assert.doesNotMatch(JSON.stringify(config), /sb_secret|test-key|session_id|user_id/);
});

test("listing, reads, SSE, sending and stopping cannot cross users even with a known session ID", async (t) => {
  const ownership = new Map([[USER_A, "sess_test"], [USER_B, "sess_b"]]);
  const { base, requests } = await app(t, ({ path }) => Response.json(session({ id: path.split("/").at(-1) })), { ownership });
  assert.deepEqual(await request(base, "local-test", "GET", prefix).then((r) => r.json()), page([session()]));
  assert.deepEqual(await request(base, "user-b", "GET", prefix).then((r) => r.json()), page([session({ id: "sess_b" })]));
  const before = requests.length;
  for (const [method, path, body] of routes.filter(([, path]) => path.includes("/sess_test"))) {
    const response = await request(base, "user-b", method, path, body);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "not_found");
  }
  assert.equal((await request(base, "local-test", "GET", prefix + "?after=sess_b")).status, 400);
  assert.equal((await request(base, "local-test", "GET", prefix + "?user_id=" + USER_B)).status, 400);
  assert.equal(requests.length, before);
});

test("a new user sees no private history, creates via the official SDK, and both devices see that same session", async (t) => {
  const { base, requests, ownership } = await app(t, ({ method, body, path }) => {
    if (method === "POST") {
      assert.equal(body.agent.model, creation.agent.model);
      assert.equal(body.input, undefined);
      return Response.json(session({ id: "sess_b" }));
    }
    return Response.json(session({ id: path.split("/").at(-1) }));
  });
  const phone = new OpenAI({ apiKey: "user-b", baseURL: base + "/v1", maxRetries: 0 }).beta.agents.sessions;
  const pc = new OpenAI({ apiKey: "user-b", baseURL: base + "/v1", maxRetries: 0 }).beta.agents.sessions;
  assert.deepEqual((await phone.list()).data, []);
  assert.equal(requests.length, 0, "Anonymous page visits do not allocate a billed environment");
  assert.equal((await phone.create(creation)).id, "sess_b");
  assert.equal(ownership.get(USER_B), "sess_b");
  assert.equal(ownership.get(USER_A), "sess_test");
  assert.deepEqual((await pc.list()).data, [session({ id: "sess_b" })]);
  await assert.rejects(pc.create(creation), { status: 409 });
  assert.equal(requests.filter((r) => r.method === "POST").length, 1);
});

test("session creation cannot import an arbitrary ID or override the application's agent policy", async (t) => {
  const { base } = await app(t, () => assert.fail("Invalid requests must not reach OpenAI"));
  for (const body of [{}, null, { ...creation, session_id: "sess_test" }, { ...creation, user_id: USER_A },
    { ...creation, agent: { model: "unapproved" } }, { ...creation, stream: true },
    { ...creation, agent: { ...creation.agent, instructions: "Unapproved" } }, { ...creation, vault_ids: ["private"] }]) {
    assert.equal((await request(base, "user-b", "POST", prefix, body ?? [])).status, 400);
  }
});

test("simultaneous first sends cannot create two conversations in this server", async (t) => {
  let complete;
  const { base, requests } = await app(t, () => new Promise((resolve) => { complete = resolve; }));
  const first = request(base, "user-b", "POST", prefix, creation);
  for (let i = 0; i < 100 && !complete; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(complete);
  assert.equal((await request(base, "user-b", "POST", prefix, creation)).status, 409);
  complete(Response.json(session({ id: "sess_b" })));
  assert.equal((await first).status, 200);
  assert.equal(requests.length, 1);
});

test("an SSE subscription closes at credential expiry without cancelling generation", { timeout: 3000 }, async (t) => {
  let aborted = false;
  const { base, requests } = await app(t, ({ signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener("abort", () => { aborted = true; controller.error(new Error("Expired")); }); },
  }), { headers: { "content-type": "text/event-stream" } }), {
    authenticate: async () => ({ id: USER_A, expiresAt: Date.now() + 80 }),
  });
  const response = await request(base, "local-test", "GET", prefix + "/sess_test/events");
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
  assert.equal(aborted, true);
  assert.deepEqual(requests.map((r) => r.method), ["GET"]);
});
