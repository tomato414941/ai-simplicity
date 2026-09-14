import assert from "node:assert/strict";
import { test } from "node:test";
import { assignSession } from "../scripts/assign-session.js";
import { USER_A } from "./helpers.js";

test("private history is assigned only to an explicitly selected, verified user without overwriting a conversation", async () => {
  const writes = [];
  let user = { id: USER_A, is_anonymous: true }, existing = null;
  const options = {
    userId: USER_A, sessionId: "sess_private",
    admin: { getUserById: async (id) => { assert.equal(id, USER_A); return { data: { user } }; } },
    store: { read: async () => existing, write: async (...args) => { writes.push(args); } },
    client: { beta: { agents: { sessions: { retrieve: async (id) => ({ id }) } } } },
  };
  await assert.rejects(assignSession(options), /verified/);
  user = { ...user, is_anonymous: false };
  await assert.rejects(assignSession(options), /verified/);
  user.email_confirmed_at = "2026-09-14T00:00:00Z";
  existing = "sess_existing";
  await assert.rejects(assignSession(options), /already has a conversation/);
  assert.deepEqual(writes, []);
  existing = null;
  await assignSession(options);
  assert.deepEqual(writes, [[USER_A, "sess_private"]]);
});
