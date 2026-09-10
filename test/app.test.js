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

test("keeps every turn in one OpenAI conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-simplicity-"));
  const calls = [];
  const client = {
    conversations: {
      create: async () => ({ id: "conv_test" }),
    },
    responses: {
      create: async (request) => {
        calls.push(request);
        return { output_text: `Reply ${calls.length}` };
      },
    },
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
  const second = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "A different topic" }),
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(
    calls.map(({ conversation: id, input }) => ({ id, input })),
    [
      { id: "conv_test", input: "First thought" },
      { id: "conv_test", input: "A different topic" },
    ],
  );

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
  assert.match(await page.text(), /placeholder="話す"/);

  const invalid = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(invalid.status, 400);
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
