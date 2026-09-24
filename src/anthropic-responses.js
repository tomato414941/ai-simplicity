import { createHash } from "node:crypto";
import { readEvents } from "../shared/agent-session.js";
import { eventStream, invalid, unsupported, upstreamFailure } from "./responses-format.js";

// Only the portable text/function subset is translated. Native server tools,
// thinking, compaction and background execution are not silently approximated.
export class AnthropicResponses {
  constructor({ apiKey, workspace, fetch: fetchImpl = globalThis.fetch }) {
    this.apiKey = apiKey; this.workspace = workspace; this.fetch = fetchImpl; this.managed = false;
  }

  // Granted rows are not carried here yet: no hosted MCP, so nothing to redact either.
  carry(params) { return params; }
  redact(value) { return value; }

  async request(path, body, options) {
    const upstream = await this.fetch("https://api.anthropic.com/v1/messages" + path, {
      method: "POST", headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json",
        ...(this.workspace ? { "anthropic-workspace-id": this.workspace } : {}) },
      body: JSON.stringify(body), signal: options.signal,
    });
    if (!upstream.ok) {
      const value = await upstream.json().catch(() => ({}));
      throw Object.assign(new Error("Anthropic request failed."), { status: upstream.status, headers: upstream.headers,
        type: value.error?.type, code: value.error?.type, requestID: upstream.headers.get("request-id") });
    }
    return upstream;
  }

  async create(body, options) {
    if (options.headers?.["Idempotency-Key"]) throw unsupported("Idempotency-Key");
    const upstream = await this.request("", messageRequest(body), options);
    const headers = {};
    if (upstream.headers.has("request-id")) headers["x-request-id"] = upstream.headers.get("request-id");
    if (body.stream) {
      if (!upstream.headers.get("content-type")?.startsWith("text/event-stream")) throw upstreamFailure();
      return eventStream(translateEvents(readEvents(upstream.body), body), headers);
    }
    return Response.json(completedResponse(await upstream.json(), body), { headers });
  }

  async inputTokens(body, options) {
    const request = messageRequest(body);
    const { model, messages, system, tools, tool_choice, thinking } = request;
    const upstream = await this.request("/count_tokens", { model, messages, system, tools, tool_choice, thinking }, options);
    const result = await upstream.json();
    if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0) throw upstreamFailure();
    return Response.json({ object: "response.input_tokens", input_tokens: result.input_tokens });
  }
  compact() { throw unsupported("compact"); }
}

export function messageRequest(body) {
  const allowed = ["model", "input", "instructions", "stream", "store", "background", "max_output_tokens", "tools", "tool_choice",
    "parallel_tool_calls", "temperature", "top_p", "metadata", "text", "truncation"];
  for (const key of Object.keys(body)) if (body[key] != null && !allowed.includes(key)) throw unsupported(key);
  if (body.background) throw unsupported("background");
  if (body.text != null && (Object.keys(body.text).some((key) => key !== "format") ||
      (body.text.format != null && (body.text.format.type !== "text" || Object.keys(body.text.format).some((key) => key !== "type"))))) throw unsupported("text");
  if (body.truncation != null && body.truncation !== "disabled") throw unsupported("truncation");
  const messages = [], system = [];
  if (body.instructions) system.push({ type: "text", text: body.instructions });
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input ?? [];
  const append = (role, content) => {
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  };
  for (const item of input) {
    if (item.type === "message" || item.role) {
      const content = textParts(item.content);
      if (["system", "developer"].includes(item.role)) {
        if (messages.length) throw unsupported("input: system/developer messages must precede the conversation");
        system.push(...content);
      } else append(item.role, content);
    } else if (item.type === "function_call") {
      let args;
      try { args = JSON.parse(item.arguments); } catch { throw invalid("Function arguments must be JSON.", "input"); }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw invalid("Function arguments must be an object.", "input");
      append("assistant", [{ type: "tool_use", id: item.call_id, name: item.name, input: args }]);
    } else if (item.type === "function_call_output") {
      append("user", [{ type: "tool_result", tool_use_id: item.call_id, content: textParts(item.output) }]);
    } else throw unsupported("input." + item.type);
  }
  const request = { model: body.model, messages, max_tokens: body.max_output_tokens ?? 4096, stream: body.stream ?? false,
    thinking: { type: "disabled" } };
  if (system.length) request.system = system;
  for (const name of ["temperature", "top_p"]) if (body[name] != null) request[name] = body[name];
  if (body.tools?.length) request.tools = body.tools.map((tool) => {
    if (tool.type !== "function") throw unsupported("tools." + tool.type);
    if (tool.strict === true) throw unsupported("tools.strict");
    return { name: tool.name, ...(tool.description ? { description: tool.description } : {}), input_schema: tool.parameters };
  });
  if (request.tools || body.tool_choice != null) {
    const choice = body.tool_choice ?? "auto";
    if (["auto", "none", "required"].includes(choice)) request.tool_choice = { type: choice === "required" ? "any" : choice };
    else if (choice?.type === "function") request.tool_choice = { type: "tool", name: choice.name };
    else throw unsupported("tool_choice");
    if (body.parallel_tool_calls != null) request.tool_choice.disable_parallel_tool_use = !body.parallel_tool_calls;
  }
  return request;
}

function textParts(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
    if (part.type === "input_text" || part.type === "output_text") return { type: "text", text: part.text };
    if (part.type === "refusal") return { type: "text", text: part.refusal };
    throw unsupported("input.content");
  });
}

function initialResponse(message, body) {
  if (message.type !== "message" || typeof message.id !== "string") throw upstreamFailure();
  return { id: message.id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: message.model,
    output: [], error: null, incomplete_details: null, previous_response_id: null, background: false, store: body.store !== false,
    instructions: body.instructions ?? null, metadata: body.metadata ?? {}, tools: body.tools ?? [], tool_choice: body.tool_choice ?? "auto",
    parallel_tool_calls: body.parallel_tool_calls ?? true, max_output_tokens: body.max_output_tokens ?? 4096,
    temperature: body.temperature ?? null, top_p: body.top_p ?? null, text: body.text ?? { format: { type: "text" } },
    truncation: "disabled", usage: null };
}

function outputItem(block, messageId, index) {
  const id = createHash("sha256").update(messageId + ":" + index).digest("hex");
  if (block.type === "text") return { id: "msg_" + id, type: "message", role: "assistant", status: "in_progress",
    content: [{ type: "output_text", text: block.text, annotations: [] }] };
  if (block.type === "tool_use") return { id: "fc_" + id, type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input), status: "in_progress" };
  throw upstreamFailure();
}

function finish(response, reason, usage) {
  if (!["end_turn", "stop_sequence", "tool_use", "max_tokens", "refusal"].includes(reason)) throw upstreamFailure();
  response.status = reason === "max_tokens" ? "incomplete" : "completed";
  response.incomplete_details = reason === "max_tokens" ? { reason: "max_output_tokens" } : null;
  if (![usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0]
    .every((amount) => Number.isSafeInteger(amount) && amount >= 0)) throw upstreamFailure();
  const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  if (!Number.isSafeInteger(input + usage.output_tokens)) throw upstreamFailure();
  response.usage = { input_tokens: input, output_tokens: usage.output_tokens, total_tokens: input + usage.output_tokens,
    input_tokens_details: { cached_tokens: usage.cache_read_input_tokens ?? 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  return response;
}

function completedResponse(message, body) {
  const result = initialResponse(message, body);
  result.output = message.content.map((block, index) => ({ ...outputItem(block, message.id, index), status: "completed" }));
  return finish(result, message.stop_reason, message.usage);
}

async function* translateEvents(events, body) {
  let response, usage = {}, reason, sequence = 0;
  const open = new Set();
  const event = (type, fields) => ({ type, sequence_number: sequence++, ...fields });
  for await (const source of events) {
    if (source.type === "ping") continue;
    if (source.type === "error") {
      yield event("error", { code: source.error?.type ?? "server_error", message: "The provider request could not be completed.", param: null });
      return;
    }
    if (source.type === "message_start") {
      if (response) throw upstreamFailure();
      response = initialResponse(source.message, body); usage = { ...source.message.usage };
      yield event("response.created", { response: structuredClone(response) });
      yield event("response.in_progress", { response: structuredClone(response) });
      continue;
    }
    if (!response) throw upstreamFailure();
    const index = source.index, item = response.output[index];
    if (source.type === "content_block_start") {
      if (index !== response.output.length) throw upstreamFailure();
      const value = outputItem(source.content_block, response.id, index);
      response.output.push(value); open.add(index);
      const added = { ...value, ...(value.type === "message" ? { content: [] } : { arguments: "" }) };
      yield event("response.output_item.added", { output_index: index, item: added });
      if (value.type === "message") {
        yield event("response.content_part.added", { item_id: value.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        if (value.content[0].text) yield event("response.output_text.delta", { item_id: value.id, output_index: index, content_index: 0, delta: value.content[0].text });
      } else value.arguments = "";
    } else if (source.type === "content_block_delta") {
      if (!item || !open.has(index)) throw upstreamFailure();
      if (source.delta.type === "text_delta" && item.type === "message") {
        item.content[0].text += source.delta.text;
        yield event("response.output_text.delta", { item_id: item.id, output_index: index, content_index: 0, delta: source.delta.text });
      } else if (source.delta.type === "input_json_delta" && item.type === "function_call") {
        item.arguments += source.delta.partial_json;
        yield event("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: source.delta.partial_json });
      } else throw upstreamFailure();
    } else if (source.type === "content_block_stop") {
      if (!item || !open.delete(index)) throw upstreamFailure();
      item.status = "completed";
      if (item.type === "message") {
        yield event("response.output_text.done", { item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text, logprobs: [] });
        yield event("response.content_part.done", { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] });
      } else {
        item.arguments ||= "{}";
        try { JSON.parse(item.arguments); } catch { throw upstreamFailure(); }
        yield event("response.function_call_arguments.done", { item_id: item.id, output_index: index, name: item.name, arguments: item.arguments });
      }
      yield event("response.output_item.done", { output_index: index, item: structuredClone(item) });
    } else if (source.type === "message_delta") {
      if (source.delta.stop_reason != null) reason = source.delta.stop_reason;
      Object.assign(usage, source.usage);
    } else if (source.type === "message_stop") {
      if (open.size) throw upstreamFailure();
      finish(response, reason, usage);
      yield event("response." + response.status, { response });
      return;
    }
  }
  // EOF without message_stop is a transport failure, never a completed response.
  throw upstreamFailure();
}
