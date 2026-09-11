import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Conversation } from "../src/conversation.js";
import { createServer } from "../src/server.js";
import { StateStore } from "../src/state-store.js";

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
});

test("keeps every turn in one managed agent session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-simplicity-"));
  const calls = [];
  const creations = [];
  const client = {
    beta: { agents: { sessions: {
      create: async (request) => { creations.push(request); return { id: "sess_test" }; },
      stream: (sessionId, request) => {
        calls.push({ sessionId, ...request });
        const reply = `Reply ${calls.length}`;
        return Object.assign((async function* () {
          yield { type: "agent.session.idle" };
          yield { type: "agent.session.turn.item.added", item: { id: "msg_test", type: "message", role: "assistant", phase: "final_answer" } };
          yield { type: "agent.session.turn.output_text.delta", item_id: "msg_test", content_index: 0, delta: "Reply " };
          yield { type: "agent.session.turn.output_text.delta", item_id: "msg_test", content_index: 0, delta: reply.slice(6) };
          yield { type: "agent.session.turn.output_text.done", item_id: "msg_test", content_index: 0, text: reply };
          yield { type: "agent.session.turn.completed", turn: { id: `turn_${calls.length}`, subagent_id: null } };
        })(), { controller: new AbortController() });
      },
    } } },
  };
  const conversation = new Conversation({
    client,
    model: "test-model",
    store: new StateStore(join(directory, "state.json")),
  });
  const server = await listen(createServer({ conversation }));
  servers.push(server);
  const baseUrl = address(server);

  const first = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "First thought" }),
  });
  assert.equal(first.status, 200);
  assert.match(await first.text(), /event: delta\ndata: \{"text":"Reply "\}/);

  const second = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "A different topic" }),
  });

  assert.equal(second.status, 200);
  assert.match(await second.text(), /event: done/);
  assert.deepEqual(
    calls.map(({ sessionId: id, input }) => ({ id, input })),
    [
      { id: "sess_test", input: "First thought" },
      { id: "sess_test", input: "A different topic" },
    ],
  );
  assert.equal(creations.length, 1);
  assert.equal(creations[0].agent.model, "test-model");
  assert.deepEqual(creations[0].agent.tools, [{ type: "web_search", mode: "live" }]);
  assert.deepEqual(creations[0].environment, { type: "openai_hosted", network: { access: "enabled" } });
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);

  const history = await fetch(`${baseUrl}/api/messages`).then((response) => response.json());
  assert.deepEqual(
    history.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "First thought" },
      { role: "assistant", text: "Reply 1" },
      { role: "user", text: "A different topic" },
      { role: "assistant", text: "Reply 2" },
    ],
  );
});

test("serves the conversation surface and validates messages", async () => {
  const conversation = {
    messages: async () => [],
    send: async () => assert.fail("send should not be called"),
  };
  const server = await listen(createServer({ conversation }));
  servers.push(server);
  const baseUrl = address(server);

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>AI<\/title>/);
  assert.match(html, /placeholder="話す"/);

  const invalid = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(invalid.status, 400);
});

test("reports a streaming failure without presenting it as complete", async () => {
  const errors = [];
  const conversation = {
    messages: async () => [],
    send: async (_text, { onDelta }) => {
      onDelta("Partial");
      throw new Error("Provider detail");
    },
  };
  const server = await listen(
    createServer({
      conversation,
      logger: { error: (error) => errors.push(error.message) },
    }),
  );
  servers.push(server);

  const response = await fetch(`${address(server)}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello" }),
  });
  const stream = await response.text();

  assert.equal(response.status, 200);
  assert.match(stream, /event: delta\ndata: \{"text":"Partial"\}/);
  assert.match(stream, /event: error/);
  assert.doesNotMatch(stream, /Provider detail/);
  assert.deepEqual(errors, ["Provider detail"]);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function address(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}
