import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrateSession } from "../scripts/migrate-session.js";
import { SessionStore } from "../src/session-store.js";

test("explicit migration preserves the entire old file in a private, non-overwritten backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-simplicity-migrate-"));
  const path = join(directory, "state.json");
  const original = JSON.stringify({ agentSessionId: "sess_test", agentLastTurnId: "turn_1", pendingAgentTurn: null, messages: [{ id: "private_input", text: "preserve this" }] });
  await writeFile(path, original, { mode: 0o600 });
  await assert.rejects(new SessionStore(path).read(), /Migrate/);
  const result = await migrateSession(path);
  assert.equal(result.preservedMessages, 1);
  assert.equal(await readFile(result.backup, "utf8"), original);
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { session_id: "sess_test" });
  await assert.rejects(migrateSession(path), /Expected an existing conversation/);
  assert.equal(await readFile(result.backup, "utf8"), original);
});

test("migration refuses pending input without touching either data or backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-simplicity-pending-"));
  const path = join(directory, "state.json");
  const original = JSON.stringify({ agentSessionId: "sess_test", pendingAgentTurn: { status: "processing" }, messages: [] });
  await writeFile(path, original, { mode: 0o600 });
  await assert.rejects(migrateSession(path), /pending input/);
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(stat(path + ".before-agents-api"), { code: "ENOENT" });
});
