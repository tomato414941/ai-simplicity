import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Only the app's session ID lives here. Items and turns belong to the session.
export class SessionStore {
  constructor(path) { this.path = path; }

  async read() {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      if (!state || Object.keys(state).length !== 1 || typeof state.session_id !== "string" || !state.session_id) {
        throw new Error("Expected a state file containing only session_id. Migrate existing data before starting.");
      }
      return state.session_id;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(sessionId) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(`${this.path}.tmp`, `${JSON.stringify({ session_id: sessionId })}\n`, { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }
}
