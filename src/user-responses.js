import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readEvents } from "../shared/agent-session.js";
import { eventStream, invalid, unsupported, upstreamFailure, responseId, responseHeaders } from "./responses-format.js";

const TERMINAL = ["completed", "incomplete", "failed", "cancelled"];
const CREATE_FIELDS = ["model", "input", "instructions", "previous_response_id", "background", "store", "stream", "stream_options",
  "tools", "tool_choice", "parallel_tool_calls", "max_tool_calls", "max_output_tokens", "reasoning", "text", "context_management",
  "temperature", "top_p", "top_logprobs", "truncation", "include", "metadata", "service_tier", "prompt_cache_key", "prompt_cache_options"];

// One public Responses contract. Routing belongs to each response, not to a
// mutable process-wide default. The Agents session implementation is separate.
export class UserResponses {
  constructor({ models, providers, store, billing }) {
    this.models = models; this.providers = providers; this.store = store; this.billing = billing;
  }

  listModels() {
    return { object: "list", data: [...this.models].map(([id, route]) => ({ id, object: "model", created: 0, owned_by: route.provider })) };
  }

  provider(name) {
    const provider = this.providers.get(name);
    if (!provider) throw unavailable("The response's provider is not configured.");
    return provider;
  }

  async owned(userId, id, options) {
    if (typeof id !== "string" || !/^resp_[\w-]{1,200}$/.test(id)) throw notFound();
    const record = await this.store.read(userId, id, options);
    if (!record) throw notFound();
    return record;
  }

  async create(userId, body, key, options) {
    const context = await this.prepare(userId, body, CREATE_FIELDS, options);
    const headers = {};
    if (key !== undefined) {
      if (typeof key !== "string" || !/^[\x21-\x7e]{1,256}$/.test(key)) throw invalid("Invalid Idempotency-Key header.", "Idempotency-Key");
      // The upstream API key is shared; another user's retry key cannot reuse
      // this user's response. No automatic retry or local response cache.
      headers["Idempotency-Key"] = createHash("sha256").update(`${userId}:${key}`).digest("hex");
    }
    const upstream = await context.provider.create(context.params, { ...options, headers });
    if (body.stream === true) return this.stream(userId, upstream, context);
    const record = await this.register(userId, context, await upstream.json());
    return Response.json(record.response, { status: upstream.status, headers: responseHeaders(upstream) });
  }

  async retrieve(userId, id, query, options) {
    const record = await this.owned(userId, id, options);
    if (!Object.keys(query).length && TERMINAL.includes(record.response?.status)) {
      await this.observe(userId, record, record.response);
      return Response.json(record.response);
    }
    const provider = this.provider(record.provider);
    if (!provider.managed) throw Object.keys(query).length ? unsupported("retrieve parameters") : unavailable("The response outcome is not available.");
    const upstream = await provider.retrieve(record.upstream_id, query, options);
    const context = { route: { provider: record.provider }, body: record.response, input: record.input, provider, record };
    if (query.stream) return this.stream(userId, upstream, context);
    const result = this.normalize(context, await upstream.json());
    await this.observe(userId, record, result);
    return Response.json(result, { headers: responseHeaders(upstream) });
  }

  async delete(userId, id, options) {
    const record = await this.owned(userId, id, options);
    if (record.provider === "openai") {
      const provider = this.provider(record.provider);
      try { await provider.delete(record.upstream_id, options); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    await this.store.delete(userId, id, options);
    return new Response(null, { status: 204 });
  }

  async cancel(userId, id, options) {
    const record = await this.owned(userId, id, options), provider = this.provider(record.provider);
    if (!provider.managed) throw unsupported("cancel: only background responses can be cancelled");
    const upstream = await provider.cancel(record.upstream_id, options);
    const result = this.normalize({ route: { provider: record.provider }, body: record.response, record }, await upstream.json());
    await this.observe(userId, record, result);
    return Response.json(result, { headers: responseHeaders(upstream) });
  }

  async inputItems(userId, id, query, options) {
    const record = await this.owned(userId, id, options);
    if (query.include?.length) throw unsupported("include");
    if (!record.input) throw unavailable("Response input is not available.");
    const items = query.order === "asc" ? record.input : [...record.input].reverse();
    const cursor = query.after ? items.findIndex((item) => item.id === query.after) : -1;
    if (query.after && cursor < 0) throw invalid("Unknown cursor.", "after");
    const data = items.slice(cursor + 1, cursor + 1 + (query.limit ?? 20));
    return Response.json({ object: "list", data, has_more: cursor + 1 + data.length < items.length, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  }

  async compact(userId, body, options) {
    const context = await this.prepare(userId, body, ["model", "input", "instructions", "previous_response_id", "service_tier", "prompt_cache_key", "prompt_cache_options"], options);
    return context.provider.compact(context.params, options);
  }

  async inputTokens(userId, body, options) {
    const context = await this.prepare(userId, body, ["model", "input", "instructions", "previous_response_id", "tools", "tool_choice",
      "parallel_tool_calls", "reasoning", "text", "truncation"], options);
    return context.provider.inputTokens(context.params, options);
  }

  async prepare(userId, body, allowed, options) {
    fields(body, allowed);
    const route = this.models.get(body.model);
    if (!route) throw invalid("Select a configured model from /v1/models.", "model");
    const provider = this.provider(route.provider), params = { ...body, model: route.model };
    for (const name of ["stream", "store", "background"]) {
      if (body[name] != null && typeof body[name] !== "boolean") throw invalid("Expected a boolean.", name);
    }
    if (body.instructions != null && typeof body.instructions !== "string") throw invalid("Expected text instructions.", "instructions");
    if (body.input !== undefined) validateInput(body.input);
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) throw invalid("Expected a tools array.", "tools");
      for (const tool of body.tools) {
        if (tool?.type === "web_search") fields(tool, ["type", "filters", "search_context_size", "user_location", "external_web_access"], "tools");
        else if (tool?.type === "function") {
          fields(tool, ["type", "name", "description", "parameters", "strict"], "tools");
          if (typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) throw invalid("Invalid function name.", "tools.name");
        }
        else throw invalid("Only web_search and function tools are supported.", "tools");
      }
    }
    if (body.tool_choice != null && typeof body.tool_choice !== "string") {
      if (body.tool_choice.type === "allowed_tools") {
        fields(body.tool_choice, ["type", "mode", "tools"], "tool_choice");
        if (!Array.isArray(body.tool_choice.tools)) throw invalid("Expected allowed tools.", "tool_choice");
        for (const tool of body.tool_choice.tools) toolChoice(tool);
      } else toolChoice(body.tool_choice);
    }
    if (body.prompt_cache_options != null) {
      fields(body.prompt_cache_options, ["mode", "prewarm", "ttl", "comparison_response_id"], "prompt_cache_options");
      if (body.prompt_cache_options.comparison_response_id != null) {
        const comparison = await this.owned(userId, body.prompt_cache_options.comparison_response_id, options);
        if (comparison.provider !== route.provider) throw unsupported("prompt_cache_options.comparison_response_id");
        params.prompt_cache_options = { ...body.prompt_cache_options, comparison_response_id: comparison.upstream_id };
      }
    }
    let input = inputItems(body.input);
    if (body.previous_response_id != null) {
      const previous = await this.owned(userId, body.previous_response_id, options);
      if (!TERMINAL.includes(previous.response?.status)) {
        await (await this.retrieve(userId, previous.id, {}, options)).json();
        Object.assign(previous, await this.owned(userId, previous.id, options));
      }
      if (!TERMINAL.includes(previous.response?.status) || !previous.input) throw unavailable("The previous response is not ready for continuation.");
      const same = previous.provider === route.provider && previous.upstream_model === route.model;
      input = [...portableItems([...previous.input, ...previous.response.output], same), ...input];
      if (provider.managed && same) params.previous_response_id = previous.upstream_id;
      else {
        delete params.previous_response_id;
        // Item IDs belong to their source provider; call_id is portable tool linkage.
        params.input = input.map(({ id, status, ...item }) => item);
      }
    }
    return { route, provider, body, params, input };
  }

  normalize(context, value) {
    const id = responseId(context.route.provider, value);
    if (context.record && id !== context.record.id) throw upstreamFailure();
    if (!Number.isFinite(value.created_at) || !Array.isArray(value.output)) throw upstreamFailure();
    return { ...value, id, model: context.body.model, previous_response_id: context.body.previous_response_id ?? null, store: context.body.store !== false };
  }

  async register(userId, context, value) {
    const response = this.normalize(context, value);
    const record = { id: response.id, provider: context.route.provider, upstream_id: value.id, upstream_model: context.route.model,
      input: identifyItems(context.input, response.id), response };
    if (response.store) await this.store.save(userId, record);
    await this.observe(userId, record, response);
    return record;
  }

  async observe(userId, record, response) {
    if (response.store && TERMINAL.includes(response.status)) await this.store.finish(userId, record.id, response);
    const base = { source: record.provider, user_id: userId, occurred_at: new Date(response.created_at * 1000).toISOString() };
    // Until the supplier reports a price, the cost is unknown, not free.
    const costId = await this.billing.recordCost({ ...base, reference: record.id + ":requested", attribution: "user", amount: null, currency: "USD", status: "unknown" });
    if (!TERMINAL.includes(response.status)) return;
    for (const metric of ["input_tokens", "output_tokens"]) {
      const amount = response.usage?.[metric];
      await this.billing.recordUsage({ ...base, reference: record.id + ":" + metric, metric, unit: "token",
        quantity: Number.isSafeInteger(amount) && amount >= 0 ? String(amount) : null,
        status: Number.isSafeInteger(amount) && amount >= 0 ? "final" : "unknown" });
    }
    if (record.provider === "openrouter" && Number.isFinite(response.usage?.cost) && response.usage.cost >= 0) {
      await this.billing.recordCost({ ...base, reference: record.id + ":final", supersedes_id: costId,
        attribution: "user", amount: response.usage.cost.toFixed(9), currency: "USD", status: "final" });
    }
  }

  async stream(userId, upstream, context) {
    if (!upstream.headers.get("content-type")?.startsWith("text/event-stream") || !upstream.body) throw upstreamFailure();
    const events = readEvents(upstream.body);
    let first, record = context.record;
    try {
      first = (await events.next()).value;
      if (!record) {
        if (first?.type === "response.created") record = await this.register(userId, context, first.response);
        else if (first?.type !== "error") throw upstreamFailure();
      }
    } catch (error) {
      await events.return();
      throw error;
    }
    const self = this;
    async function* output() {
      let event = first;
      try {
        while (event) {
          if (event.response) {
            const response = self.normalize({ ...context, record }, event.response);
            if ((event !== first || context.record) && TERMINAL.includes(response.status)) await self.observe(userId, record, response);
            event = { ...event, response };
          }
          yield event;
          event = (await events.next()).value;
        }
      } finally { await events.return(); }
    }
    return eventStream(output(), responseHeaders(upstream));
  }
}

export class SupabaseResponseStore {
  constructor(client) { this.client = client; }

  async read(userId, id, options = {}) {
    let query = this.client.from("responses").select("id,provider,upstream_id,upstream_model,input,response").eq("user_id", userId).eq("id", id).maybeSingle();
    if (options.signal) query = query.abortSignal(options.signal);
    const { data, error } = await query;
    if (error) throw storageFailure();
    return data;
  }

  async save(userId, record) {
    const { error } = await this.client.from("responses").insert({ ...record, user_id: userId });
    if (!error) return;
    if (error.code === "23505") {
      const found = await this.read(userId, record.id);
      if (found && found.provider === record.provider && found.upstream_id === record.upstream_id && found.upstream_model === record.upstream_model && isDeepStrictEqual(found.input, record.input)) return;
    }
    throw storageFailure();
  }

  async finish(userId, id, response) {
    // Completed snapshots do not regress when another reader sees stale state.
    const { error } = await this.client.from("responses").update({ response }).eq("user_id", userId).eq("id", id)
      .or("response.is.null,response->>status.in.(queued,in_progress)");
    if (error) throw storageFailure();
  }

  async delete(userId, id, options = {}) {
    let query = this.client.from("responses").delete().eq("user_id", userId).eq("id", id);
    if (options.signal) query = query.abortSignal(options.signal);
    const { error } = await query;
    if (error) throw storageFailure();
  }
}

function inputItems(input) { return typeof input === "string" ? [{ role: "user", content: input }] : input ?? []; }
function identifyItems(items, id) {
  return items.map((item, index) => {
    const identified = { ...item, id: item.id ?? "msg_" + createHash("sha256").update(id + ":" + index).digest("hex") };
    if (item.role) {
      identified.type = "message";
      identified.status ??= "completed";
      if (typeof item.content === "string") identified.content = [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.content }];
    }
    return identified;
  });
}
function portableItems(items, same) {
  return items.filter((item) => {
    if (item.type === "compaction") {
      if (!same) throw unsupported("previous_response_id: compacted context cannot be transferred to another model");
      return true;
    }
    if (item.type === "reasoning") return same && Boolean(item.encrypted_content);
    return item.role || ["function_call", "function_call_output"].includes(item.type);
  });
}

function validateInput(input) {
  if (typeof input === "string") return;
  if (!Array.isArray(input)) throw invalid("Expected text or an input items array.", "input");
  for (const item of input) {
    if (item?.type === "message" || (item?.type === undefined && item?.role)) {
      fields(item, ["type", "id", "role", "content", "phase", "status"], "input");
      if (!["user", "assistant", "system", "developer"].includes(item.role)) throw invalid("Invalid message role.", "input");
      textContent(item.content);
    } else if (item?.type === "function_call") {
      fields(item, ["type", "id", "call_id", "name", "arguments", "status"], "input");
      if (typeof item.arguments !== "string") throw invalid("Supply the function call arguments.", "input");
    } else if (item?.type === "function_call_output") {
      fields(item, ["type", "id", "call_id", "output", "status"], "input");
      textContent(item.output);
    } else if (["reasoning", "compaction"].includes(item?.type)) {
      fields(item, ["type", "id", "encrypted_content", ...(item.type === "reasoning" ? ["summary", "content", "status"] : [])], "input");
      if (typeof item.encrypted_content !== "string" || !item.encrypted_content) {
        throw invalid("Supply encrypted_content or continue with previous_response_id.", "input");
      }
    } else {
      throw invalid("This input item type is not supported. Supply text, function items or encrypted context.", "input");
    }
  }
}

function textContent(content) {
  if (typeof content === "string") return;
  if (!Array.isArray(content) || !content.length) throw invalid("Supply message text or tool output.", "input");
  for (const part of content) {
    if (["input_text", "output_text"].includes(part?.type)) {
      fields(part, ["type", "text", "annotations", "logprobs", "prompt_cache_breakpoint"], "input");
      if (typeof part.text !== "string") throw invalid("Expected text content.", "input");
    } else if (part?.type === "refusal") {
      fields(part, ["type", "refusal"], "input");
      if (typeof part.refusal !== "string") throw invalid("Expected refusal text.", "input");
    } else throw invalid("Only text content is supported.", "input");
  }
}

function fields(value, allowed, param) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Expected an object.", param);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid("Unsupported parameter.", param ? `${param}.${key}` : key);
}
function toolChoice(value) {
  if (!["function", "web_search"].includes(value?.type)) throw invalid("Unsupported tool choice.", "tool_choice");
  fields(value, value.type === "function" ? ["type", "name"] : ["type"], "tool_choice");
  if (value.type === "function" && (typeof value.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.name))) throw invalid("Invalid function name.", "tool_choice.name");
}
function storageFailure() { return Object.assign(new Error("Response ownership storage is unavailable."), { status: 503 }); }
function unavailable(message) { return Object.assign(new Error(message), { status: 503, code: "response_unavailable" }); }
function notFound() { return Object.assign(invalid("Not found."), { status: 404, code: "not_found" }); }
