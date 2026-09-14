import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import OpenAI from "openai";
import { app, session, turn, item, userItem, page, messageEvent, authFetch as fetch } from "./helpers.js";

const prefix = "/v1/agents/sessions/sess_test";
const post = (base, events, key, extra = {}) => fetch(base + prefix + "/events", {
  method: "POST", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}), ...extra }, body: JSON.stringify({ events }),
});

test("native session, item and turn resources preserve schemas and pagination", async (t) => {
  const nativeItems = page([userItem(), item("途中"), { id: "tool_1", type: "web_search_call", status: "completed", turn_id: "turn_1", action: { type: "search", queries: ["test"] } }], true);
  const { base, requests } = await app(t, async ({ path }) => Response.json(
    path.endsWith("/items") ? nativeItems : path.endsWith("/turns") ? page([turn()]) : path.endsWith("/turn_1") ? turn() : session(),
  ));
  assert.deepEqual(await fetch(base + "/v1/agents/sessions").then((r) => r.json()), page([session()]));
  assert.deepEqual(await fetch(base + prefix).then((r) => r.json()), session());
  assert.deepEqual(await fetch(base + prefix + "/items?order=asc&limit=2&after=msg_previous").then((r) => r.json()), nativeItems);
  const request = requests.at(-1);
  assert.deepEqual(Object.fromEntries(request.query), { order: "asc", limit: "2", after: "msg_previous" });
  assert.equal(request.headers.get("OpenAI-Beta"), "agents=v1");
  assert.deepEqual(await fetch(base + prefix + "/turns/turn_1").then((r) => r.json()), turn());
  // Exercise the supported contract with the SDK without requiring it in clients.
  const local = new OpenAI({ apiKey: "local-test", baseURL: base + "/v1", maxRetries: 0 });
  assert.deepEqual((await local.beta.agents.sessions.items.list("sess_test")).data, nativeItems.data);
  assert.deepEqual(await local.beta.agents.sessions.turns.retrieve("turn_1", { session_id: "sess_test" }), turn());
});

test("input stays unchanged and duplicates use the native Idempotency-Key", async (t) => {
  const accepted = new Set();
  let generations = 0;
  const { base, requests } = await app(t, async ({ headers, body }) => {
    const key = headers.get("idempotency-key");
    assert.deepEqual(body, { events: [messageEvent("  exact input  ")] });
    if (!accepted.has(key)) { accepted.add(key); generations++; }
    return new Response(null, { status: 204 });
  });
  const first = await post(base, [messageEvent("  exact input  ")], "input_1");
  assert.equal(first.status, 204);
  assert.equal(await first.text(), "");
  assert.equal((await post(base, [messageEvent("  exact input  ")], "input_1")).status, 204);
  assert.equal(generations, 1);
  assert.equal(requests.length, 2);
});

test("cancellation is the native input event and is never automatically replayed", async (t) => {
  const { base, requests } = await app(t, async ({ body }) => {
    assert.deepEqual(body, { events: [{ type: "agent.session.input.cancel" }] });
    return Response.json({ error: { type: "server_error", code: "internal_error", message: "Private diagnostic" } }, { status: 500 });
  });
  const response = await post(base, [{ type: "agent.session.input.cancel" }]);
  assert.equal(response.status, 500);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(await response.text(), /Private diagnostic/);
});

test("SSE forwards bytes and native errors incrementally; viewer disconnect does not cancel work", async (t) => {
  let output, upstreamAborted = false;
  const { base, requests } = await app(t, async ({ signal }) => {
    signal.addEventListener("abort", () => { upstreamAborted = true; output.error(new Error("aborted")); });
    return new Response(new ReadableStream({ start(controller) { output = controller; } }), { headers: { "content-type": "text/event-stream" } });
  });
  const controller = new AbortController();
  const response = await fetch(base + prefix + "/events", { signal: controller.signal });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(response.headers.get("cache-control"), /no-transform/);
  const reader = response.body.getReader();
  const first = ': keepalive\n\nevent: agent.session.turn.output_text.delta\ndata: {"type":"agent.session.turn.output_text.delta","delta":"途中","item_id":"msg_answer"}\n\n';
  output.enqueue(new TextEncoder().encode(first));
  assert.equal(new TextDecoder().decode((await reader.read()).value), first);
  const errorEvent = 'data: {"type":"error","event_id":"evt_error","session_id":"sess_test","error":{"code":"internal_error","message":"Unavailable"}}\n\n';
  output.enqueue(new TextEncoder().encode(errorEvent));
  assert.equal(new TextDecoder().decode((await reader.read()).value), errorEvent);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 30 && !upstreamAborted; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(upstreamAborted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
});

test("upstream failures are HTTP errors, not successful snapshots or fake turn failures", async (t) => {
  const { base, logs } = await app(t, async () => Response.json({ error: { type: "server_error", code: "internal_error", message: "Private chat and key details" } }, { status: 503 }));
  const response = await fetch(base + prefix);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.type, "server_error");
  assert.equal(body.error.code, "internal_error");
  assert.doesNotMatch(JSON.stringify([body, logs]), /Private chat|key details|test-key/);
});

test("HTTP clients and the SDK receive native error classification and retry metadata", async (t) => {
  const { base } = await app(t, async () => Response.json({ error: {
    type: "rate_limit_error", code: "rate_limit_exceeded", param: "events", message: "Private diagnostic",
  } }, { status: 429, headers: {
    "retry-after": "7", "retry-after-ms": "7000", "x-request-id": "req_rate_limit", "x-should-retry": "false",
    "set-cookie": "upstream-secret=private", "x-private-header": "private",
  } }));
  const response = await post(base, [messageEvent()], "input_limited");
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.type, "rate_limit_error");
  assert.equal(body.error.code, "rate_limit_exceeded");
  assert.equal(body.error.param, "events");
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal(response.headers.get("retry-after-ms"), "7000");
  assert.equal(response.headers.get("x-request-id"), "req_rate_limit");
  assert.equal(response.headers.get("x-should-retry"), "false");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-private-header"), null);
  assert.doesNotMatch(JSON.stringify(body), /Private diagnostic/);

  const client = new OpenAI({ apiKey: "local-test", baseURL: base + "/v1", maxRetries: 0 });
  await assert.rejects(client.beta.agents.sessions.events.create("sess_test", { events: [messageEvent()] }), (error) => {
    assert.ok(error instanceof OpenAI.RateLimitError);
    assert.equal(error.type, "rate_limit_error");
    assert.equal(error.param, "events");
    assert.equal(error.headers.get("retry-after"), "7");
    assert.equal(error.requestID, "req_rate_limit");
    return true;
  });
});

test("unsupported endpoints, parameters and inputs are rejected, not silently translated", async (t) => {
  const { base, requests } = await app(t, () => assert.fail("Invalid requests must not reach OpenAI"));
  for (const path of ["/api/messages", "/api/retry", "/api/stop", "/v1/responses", "/v1/agents/sessions/sess_unowned", prefix + "/events/another"]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  for (const query of ["limit=0", "limit=101", "limit=1.5", "order=wrong", "run_id=1", "limit=1&limit=2"]) {
    assert.equal((await fetch(base + prefix + "/items?" + query)).status, 400, query);
  }
  assert.equal((await fetch(base + prefix + "/events?after=evt_missing")).status, 400);
  for (const events of [[], [null], [{ type: "custom" }], [{ ...messageEvent(), stopRequested: true }],
    [{ type: "agent.session.input.cancel", turn_id: "turn_1" }], [messageEvent(" ")], [messageEvent("a".repeat(20_001))],
    [{ type: "agent.session.input.message", input: [{ role: "assistant", content: [{ type: "input_text", text: "hi" }] }] }],
    [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/image" }] }] }]]) {
    assert.equal((await post(base, events)).status, 400, JSON.stringify(events).slice(0, 100));
  }
  assert.equal(requests.length, 0);
});

test("cross-origin writes and non-JSON requests are rejected", async (t) => {
  const { base } = await app(t, () => assert.fail("Untrusted writes must not reach OpenAI"));
  assert.equal((await post(base, [messageEvent()], undefined, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(base, [messageEvent()], undefined, { "content-type": "text/plain" })).status, 415);
  assert.equal((await fetch(base + prefix + "/events", { method: "POST", headers: { "content-type": "application/json" }, body: "null" })).status, 400);
});

test("serves only explicit public files and keeps the single send/stop button", async (t) => {
  const { base } = await app(t, () => assert.fail("Static requests do not call OpenAI"));
  const html = await fetch(base).then((r) => r.text());
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8") + await readFile(new URL("../public/account.js", import.meta.url), "utf8");
  for (const [, id] of script.matchAll(/document.querySelector\("#([\w-]+)"\)/g)) assert.ok(html.includes(`id="${id}"`));
  assert.equal([...html.split('<form id="composer"')[1].split("</form>")[0].matchAll(/<button\b/g)].length, 1);
  for (const path of ["/", "/index.html", "/app.js", "/styles.css"]) {
    const response = await fetch(base + path); assert.equal(response.status, 200); await response.body.cancel();
  }
  for (const path of ["/account.js", "/auth.js", "/agent-session.js", "/package.json", "/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/src/server.js", "/constructor", "/__proto__", "/file:/etc/passwd", "/file:%2fetc%2fpasswd"]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.deepEqual(await fetch(base + "/api/health").then((r) => r.json()), { ok: true });
});
