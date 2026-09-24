import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { createServer } from "../src/server.js";
import { UserSessions } from "../src/user-sessions.js";
import { unauthorized } from "../src/auth.js";
import { UserResponses } from "../src/user-responses.js";
import { responseConfiguration } from "../src/response-providers.js";

export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";
export function authFetch(url, options = {}) {
  return fetch(url, { ...options, headers: { Authorization: "Bearer local-test", ...options.headers } });
}

export const session = (fields = {}) => ({
  id: "sess_test", object: "agent.session", status: "idle", created_at: 1, last_active_at: 1,
  agent: { id: "agent_test", model: "gpt-6-astra" }, environment: { type: "none" },
  error: null, metadata: {}, required_actions: [], usage: null, vault_ids: [], ...fields,
});
export const turn = (fields = {}) => ({
  id: "turn_1", object: "agent.session.turn", session_id: "sess_test", agent_id: "agent_test",
  status: "in_progress", subagent_id: null, created_at: 1, started_at: 1, completed_at: null,
  error: null, usage: null, ...fields,
});
export const item = (text = "", fields = {}) => ({
  id: "msg_answer", type: "message", role: "assistant", phase: "final_answer", turn_id: "turn_1",
  content: [{ type: "output_text", text }], status: "in_progress", ...fields,
});
export const userItem = (text = "こんにちは", fields = {}) => item(text, {
  id: "msg_user", role: "user", phase: null, status: "completed", content: [{ type: "input_text", text }], ...fields,
});
export const page = (data, hasMore = false) => ({ object: "list", data, has_more: hasMore, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
export const messageEvent = (text = "こんにちは") => ({
  type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text }] }],
});
export const turnEvent = (fields = {}) => {
  const value = turn(fields);
  return { type: `agent.session.turn.${value.status === "queued" ? "created" : value.status}`, event_id: `evt_${value.id}_${value.status}`, session_id: value.session_id, turn_id: value.id, turn: value };
};

export async function app(t, handler, options = {}) {
  const requests = [], logs = [];
  const transport = async (url, options) => {
      const request = { host: new URL(url).host, path: new URL(url).pathname, query: new URL(url).searchParams, method: options.method,
        headers: new Headers(options.headers), body: options.body ? JSON.parse(options.body) : null, signal: options.signal };
      requests.push(request);
      return handler(request);
  };
  const client = new OpenAI({ apiKey: "test-key", maxRetries: 0, fetch: transport });
  const ownership = options.ownership ?? new Map([[USER_A, "sess_test"]]);
  const sessions = new UserSessions({ client, model: "gpt-6-astra", store: {
    read: async (userId) => ownership.get(userId) ?? null,
    write: async (userId, sessionId) => {
      assertUnique(userId, sessionId);
      ownership.set(userId, sessionId);
    },
  } });
  function assertUnique(userId, sessionId) {
    if (ownership.has(userId) || [...ownership.values()].includes(sessionId)) throw Object.assign(new Error("Duplicate ownership"), { status: 409 });
  }
  const authenticate = options.authenticate ?? (async (request) => {
    const id = new Map([["Bearer local-test", USER_A], ["Bearer user-b", USER_B]]).get(request.headers.authorization);
    if (!id) throw unauthorized();
    return { id, expiresAt: Date.now() + 60_000 };
  });
  const publicConfig = { supabase: { url: "https://example.supabase.co", publishableKey: "sb_publishable_test" }, session: sessions.defaults };
  const observations = [], observationIds = new Map();
  const observe = (kind, record) => {
    const key = kind + ":" + record.source + ":" + record.reference;
    if (!observationIds.has(key)) observationIds.set(key, randomUUID());
    observations.push({ kind, ...record, id: observationIds.get(key) });
    return observationIds.get(key);
  };
  const billing = {
    balance: async () => { throw new Error("Provide a billing fixture for billing requests."); },
    history: async () => { throw new Error("Provide a billing fixture for billing requests."); },
    recordCost: async (record) => observe("cost", record), recordUsage: async (record) => observe("usage", record),
    ...options.billing,
  };
  const responseOwners = options.responseOwners ?? new Map();
  const responseRecords = options.responseRecords ?? new Map([...responseOwners].map(([id]) => [id, {
    id, provider: "openai", upstream_id: id, upstream_model: "gpt-6-astra", input: [], response: { id, object: "response", model: "gpt-6-astra", created_at: 1,
      status: "completed", output: [], store: true, previous_response_id: null },
  }]));
  const configuration = responseConfiguration({ OPENAI_API_KEY: "test-key", OPENROUTER_API_KEY: "router-key", ANTHROPIC_API_KEY: "anthropic-key",
    ...(options.models ? { RESPONSES_MODELS: JSON.stringify(options.models) } : {}) }, transport);
  const foundationKeys = options.foundationKeys ?? new Map();
  const responses = new UserResponses({ ...configuration, billing, foundation: options.foundation ?? null,
    keys: { read: async (id) => foundationKeys.get(id) ?? null, write: async (id, keyId) => foundationKeys.set(id, keyId) }, store: options.responseStore ?? {
    read: async (userId, id) => responseOwners.get(id) === userId ? structuredClone(responseRecords.get(id)) : null,
    save: async (userId, record) => {
      if (responseOwners.has(record.id) && responseOwners.get(record.id) !== userId) throw Object.assign(new Error("Conflicting owner"), { status: 503 });
      responseOwners.set(record.id, userId);
      if (!responseRecords.has(record.id)) responseRecords.set(record.id, structuredClone(record));
    },
    finish: async (userId, id, response) => {
      if (responseOwners.get(id) !== userId) throw new Error("Owner mismatch");
      const record = responseRecords.get(id);
      if (!["completed", "incomplete", "cancelled", "failed"].includes(record.response?.status)) record.response = structuredClone(response);
    },
    delete: async (userId, id) => { if (responseOwners.get(id) !== userId) throw new Error("Owner mismatch"); responseOwners.delete(id); responseRecords.delete(id); },
  } });
  const server = createServer({ sessions, responses, billing, authenticate, publicConfig, foundation: options.foundation ?? null, logger: { error: (value) => logs.push(value), log: () => {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, logs, server, ownership, responseOwners, responseRecords, observations };
}
