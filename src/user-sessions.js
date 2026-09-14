import { AgentSession, INSTRUCTIONS, OPTIONS } from "./agent-session.js";

export class UserSessions {
  constructor({ client, store, model }) {
    this.client = client;
    this.store = store;
    this.model = model;
    this.creating = new Set();
    this.defaults = { agent: { model }, environment: { type: "openai_hosted" } };
  }

  async list(userId, query, options) {
    const id = await this.store.read(userId, options);
    if (query.after && query.after !== id) throw failure(400, "Unknown cursor.", "after");
    if (!id) return { object: "list", data: [], first_id: null, last_id: null, has_more: false };
    return new AgentSession({ client: this.client, id }).list(query, options);
  }

  async owned(userId, id, options) {
    if (await this.store.read(userId, options) !== id) throw failure(404, "Not found.");
    return new AgentSession({ client: this.client, id });
  }

  async create(userId, body) {
    // This app supports one continuous conversation and a fixed agent policy,
    // not every session-creation option. Unsupported fields fail explicitly.
    const only = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).every((key) => keys.includes(key));
    if (!only(body, ["agent", "environment"]) || !only(body.agent, ["model"]) || body.agent.model !== this.model ||
        !only(body.environment, ["type"]) || body.environment.type !== "openai_hosted") {
      throw failure(400, "Use the supported agent and environment configuration.");
    }
    if (this.creating.has(userId)) throw failure(409, "A conversation is already being created.");
    this.creating.add(userId);
    try {
      if (await this.store.read(userId)) throw failure(409, "A conversation already exists.");
      // Complete ownership persistence even if the viewer disconnects. A read
      // on reconnect discovers the session; creation is never automatically retried.
      const session = await this.client.beta.agents.sessions.create({
        agent: {
          model: this.model, instructions: INSTRUCTIONS,
          tools: [{ type: "web_search", mode: "live" }], multi_agent: { enabled: false },
        },
        environment: { type: "openai_hosted", network: { access: "enabled" } },
      }, OPTIONS);
      await this.store.write(userId, session.id);
      return session;
    } finally { this.creating.delete(userId); }
  }
}

export class SupabaseSessionStore {
  constructor(client) { this.client = client; }

  async read(userId, options = {}) {
    let query = this.client.from("agent_sessions").select("session_id").eq("user_id", userId).maybeSingle();
    if (options.signal) query = query.abortSignal(options.signal);
    const { data, error } = await query;
    if (error) throw failure(503, "Conversation storage is unavailable.");
    return data?.session_id ?? null;
  }

  async write(userId, sessionId) {
    const { error } = await this.client.from("agent_sessions").insert({ user_id: userId, session_id: sessionId });
    if (error) throw failure(error.code === "23505" ? 409 : 503, "Could not save conversation ownership.");
  }
}

function failure(status, message, param) {
  return Object.assign(new Error(message), { status, local: status < 500, param,
    code: status === 404 ? "not_found" : status === 409 ? "conflict" : null });
}
