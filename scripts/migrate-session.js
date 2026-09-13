import { constants } from "node:fs";
import { copyFile, readFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionStore } from "../src/session-store.js";

// One-time, explicit data migration. The application never reads the old format.
export async function migrateSession(path) {
  const previous = JSON.parse(await readFile(path, "utf8"));
  if (typeof previous.agentSessionId !== "string" || !previous.agentSessionId || !Array.isArray(previous.messages)) {
    throw new Error("Expected an existing conversation state with an agentSessionId.");
  }
  if (previous.pendingAgentTurn) throw new Error("Resolve the pending input before migrating.");
  const backup = `${path}.before-agents-api`;
  await copyFile(path, backup, constants.COPYFILE_EXCL);
  await chmod(backup, 0o600);
  await new SessionStore(path).write(previous.agentSessionId);
  return { backup, preservedMessages: previous.messages.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/migrate-session.js /absolute/path/to/state.json (stop the app first)");
  console.log(JSON.stringify(await migrateSession(resolve(process.argv[2]))));
}
