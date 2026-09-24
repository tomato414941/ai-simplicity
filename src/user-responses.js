import { createHash } from "node:crypto";
import { readEvents } from "../shared/agent-session.js";

const OPTIONS = { maxRetries: 0, timeout: 600_000 };
const CREATE_FIELDS = ["model", "input", "instructions", "previous_response_id", "background", "store", "stream", "stream_options",
  "tools", "tool_choice", "parallel_tool_calls", "max_tool_calls", "max_output_tokens", "reasoning", "text", "context_management",
  "temperature", "top_p", "top_logprobs", "truncation", "include", "metadata", "service_tier", "prompt_cache_key", "prompt_cache_options"];

// Native Responses resources, separate from Agents sessions. This app currently
// exposes text, web search and function tools, not project-wide files or compute.
export class UserResponses {
  constructor({ client, store, model }) {
    this.api = client.responses;
    this.store = store;
    this.model = model;
  }

  async owned(userId, id, options) {
    if (typeof id !== "string" || !/^resp_[\w-]{1,200}$/.test(id) || !await this.store.owns(userId, id, options)) {
      throw Object.assign(invalid("Not found."), { status: 404, code: "not_found" });
    }
  }

  async create(userId, body, key, options) {
    await this.validate(userId, body, CREATE_FIELDS, options);
    const headers = {};
    if (key !== undefined) {
      if (typeof key !== "string" || !/^[\x21-\x7e]{1,256}$/.test(key)) throw invalid("Invalid Idempotency-Key header.", "Idempotency-Key");
      // The upstream API key is shared; another user's retry key cannot reuse
      // this user's response. No automatic retry or local response cache.
      headers["Idempotency-Key"] = createHash("sha256").update(`${userId}:${key}`).digest("hex");
    }
    const upstream = await this.api.create(body, { ...OPTIONS, ...options, headers }).asResponse();
    if (body.stream === true) return this.registerStream(userId, upstream, body.store !== false);
    const result = await upstream.json();
    if (body.store !== false) await this.store.save(userId, responseId(result));
    return Response.json(result, { status: upstream.status, headers: upstream.headers });
  }

  async retrieve(userId, id, query, options) {
    await this.owned(userId, id, options);
    return this.api.retrieve(id, query, { ...OPTIONS, ...options }).asResponse();
  }

  async delete(userId, id, options) {
    await this.owned(userId, id, options);
    return this.api.delete(id, { ...OPTIONS, ...options }).asResponse();
  }

  async cancel(userId, id, options) {
    await this.owned(userId, id, options);
    return this.api.cancel(id, { ...OPTIONS, ...options }).asResponse();
  }

  async inputItems(userId, id, query, options) {
    await this.owned(userId, id, options);
    return this.api.inputItems.list(id, query, { ...OPTIONS, ...options }).asResponse();
  }

  async compact(userId, body, options) {
    await this.validate(userId, body, ["model", "input", "instructions", "previous_response_id", "service_tier", "prompt_cache_key", "prompt_cache_options"], options);
    return this.api.compact(body, { ...OPTIONS, ...options }).asResponse();
  }

  async inputTokens(userId, body, options) {
    await this.validate(userId, body, ["model", "input", "instructions", "previous_response_id", "tools", "tool_choice",
      "parallel_tool_calls", "reasoning", "text", "truncation"], options);
    return this.api.inputTokens.count(body, { ...OPTIONS, ...options }).asResponse();
  }

  async validate(userId, body, allowed, options) {
    fields(body, allowed);
    if (body.model !== this.model) throw invalid("Use the application's configured model.", "model");
    for (const name of ["stream", "store", "background"]) {
      if (body[name] != null && typeof body[name] !== "boolean") throw invalid("Expected a boolean.", name);
    }
    if (body.instructions != null && typeof body.instructions !== "string") throw invalid("Expected text instructions.", "instructions");
    if (body.input !== undefined) validateInput(body.input);
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) throw invalid("Expected a tools array.", "tools");
      for (const tool of body.tools) {
        if (tool?.type === "web_search") fields(tool, ["type", "filters", "search_context_size", "user_location", "external_web_access"], "tools");
        else if (tool?.type === "function") fields(tool, ["type", "name", "description", "parameters", "strict"], "tools");
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
      if (body.prompt_cache_options.comparison_response_id != null) await this.owned(userId, body.prompt_cache_options.comparison_response_id, options);
    }
    if (body.previous_response_id != null) await this.owned(userId, body.previous_response_id, options);
  }

  async registerStream(userId, upstream, store) {
    if (!upstream.headers.get("content-type")?.startsWith("text/event-stream") || !upstream.body) throw upstreamFailure();
    if (!store) return upstream;
    // Read just the opening event to persist ownership before exposing its ID.
    // The other branch preserves the original SSE bytes, including error events.
    const [body, inspection] = upstream.body.tee();
    const events = readEvents(inspection);
    try {
      const { value } = await events.next();
      if (value?.type === "response.created") await this.store.save(userId, responseId(value.response));
      else if (value?.type !== "error") throw upstreamFailure();
      return new Response(body, { status: upstream.status, headers: upstream.headers });
    } catch (error) {
      void body.cancel().catch(() => {});
      throw error;
    } finally {
      await events.return();
    }
  }
}

export class SupabaseResponseStore {
  constructor(client) { this.client = client; }

  async owns(userId, id, options = {}) {
    let query = this.client.from("responses").select("id").eq("user_id", userId).eq("id", id).maybeSingle();
    if (options.signal) query = query.abortSignal(options.signal);
    const { data, error } = await query;
    if (error) throw storageFailure();
    return Boolean(data);
  }

  async save(userId, id) {
    const { error } = await this.client.from("responses").insert({ id, user_id: userId });
    if (!error || (error.code === "23505" && await this.owns(userId, id))) return;
    throw storageFailure();
  }
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
}
function responseId(value) {
  if (value?.object !== "response" || typeof value.id !== "string" || !/^resp_[\w-]{1,200}$/.test(value.id)) throw upstreamFailure();
  return value.id;
}
function invalid(message, param) { return Object.assign(new Error(message), { status: 400, local: true, param }); }
function upstreamFailure() { return Object.assign(new Error("Invalid response from provider."), { status: 502 }); }
function storageFailure() { return Object.assign(new Error("Response ownership storage is unavailable."), { status: 503 }); }
