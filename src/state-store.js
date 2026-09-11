import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = Object.freeze({
  conversationId: null,
  agentSessionId: null,
  agentLastTurnId: null,
  pendingAgentTurn: null,
  messages: [],
});

export class StateStore {
  #path;
  #state;
  #writeQueue = Promise.resolve();

  constructor(path) {
    this.#path = path;
  }

  async read() {
    if (!this.#state) {
      this.#state = await this.#load();
    }

    return structuredClone(this.#state);
  }

  async update(change) {
    const operation = this.#writeQueue.then(async () => {
      const current = await this.read();
      const next = await change(current);
      validateState(next);
      await this.#persist(next);
      this.#state = structuredClone(next);
      return structuredClone(next);
    });

    this.#writeQueue = operation.catch(() => {});
    return operation;
  }

  async #load() {
    try {
      const raw = await readFile(this.#path, "utf8");
      const state = JSON.parse(raw);
      validateState(state);
      return state;
    } catch (error) {
      if (error.code === "ENOENT") {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  async #persist(state) {
    const directory = dirname(this.#path);
    const temporaryPath = `${this.#path}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.#path);
  }
}

function validateState(state) {
  if (
    !state ||
    (state.conversationId !== null && typeof state.conversationId !== "string") ||
    (state.agentSessionId != null && typeof state.agentSessionId !== "string") ||
    (state.agentLastTurnId != null && typeof state.agentLastTurnId !== "string") ||
    (state.pendingAgentTurn != null && (
      !state.agentSessionId ||
      ["text", "input", "idempotencyKey", "createdAt"].some(
        (field) => typeof state.pendingAgentTurn[field] !== "string",
      )
    )) ||
    !Array.isArray(state.messages) ||
    state.messages.some(
      (message) =>
        !message ||
        !["user", "assistant"].includes(message.role) ||
        typeof message.text !== "string" ||
        typeof message.createdAt !== "string",
    )
  ) {
    throw new Error("The state file has an invalid shape.");
  }
}
