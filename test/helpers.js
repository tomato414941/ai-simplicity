import OpenAI from "openai";
import { createServer } from "../src/server.js";
import { AgentSession } from "../src/agent-session.js";

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

export async function app(t, handler) {
  const requests = [], logs = [];
  const client = new OpenAI({
    apiKey: "test-key", maxRetries: 0,
    fetch: async (url, options) => {
      const request = { path: new URL(url).pathname, query: new URL(url).searchParams, method: options.method,
        headers: new Headers(options.headers), body: options.body ? JSON.parse(options.body) : null, signal: options.signal };
      requests.push(request);
      return handler(request);
    },
  });
  const agentSession = new AgentSession({ client, model: "gpt-6-astra", store: { read: async () => "sess_test", write() { throw new Error("No runtime writes expected."); } } });
  await agentSession.initialize();
  const server = createServer({ session: agentSession, logger: { error: (value) => logs.push(value) } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, logs, server };
}
