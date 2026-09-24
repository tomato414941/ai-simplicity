import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";

const MAX_BODY_BYTES = 128 * 1024;
const PREFIX = "/v1/agents/sessions";
const PUBLIC_ASSETS = new Map([
  ["/", ["index.html", "text/html"]],
  ["/foundation", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/styles.css", ["styles.css", "text/css"]],
]);

export function createServer({ sessions, responses, billing, authenticate, publicConfig, foundation = null, logger = console }) {
  if (!sessions || !responses || !billing || typeof authenticate !== "function") throw new Error("Authentication, user-scoped sessions, responses and billing are required.");
  return createHttpServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    const options = { signal: controller.signal };
    try {
      const url = new URL(request.url, "http://localhost");
      const method = request.method;
      if (method === "GET" && url.pathname === "/api/health") return sendJson(response, 200, { ok: true });
      if (method === "GET" && url.pathname === "/api/config") return sendJson(response, 200, publicConfig);

      // Foundation tells us, signed, when one of our users' requests finished. Nothing else arrives here.
      if (method === "POST" && url.pathname === "/api/foundation/events") {
        const raw = await readRaw(request);
        if (!foundation?.verify(request.headers["foundation-signature"], raw)) throw Object.assign(invalid("Bad signature."), { status: 401 });
        const event = JSON.parse(raw);
        logger.log?.(`foundation ${event.type} for ${event.account}`);
        response.writeHead(204); return response.end();
      }
      const isFoundation = url.pathname === "/api/foundation/links";
      const isBilling = url.pathname === "/api/billing" || url.pathname.startsWith("/api/billing/");
      const isResponses = url.pathname === "/v1/responses" || url.pathname.startsWith("/v1/responses/");
      const isModels = url.pathname === "/v1/models";
      const user = (isFoundation || isBilling || isResponses || isModels || url.pathname === PREFIX || url.pathname.startsWith(PREFIX + "/")) ? await authenticate(request) : null;
      if (user && ["POST", "DELETE"].includes(method) && request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        throw Object.assign(invalid("Origin is not allowed."), { status: 403 });
      }

      if (isModels && method === "GET") {
        noQuery(url);
        return sendJson(response, 200, responses.listModels());
      }

      if (isResponses) {
        const expiry = setTimeout(() => { controller.abort(); response.destroy(); }, Math.max(1, Math.min(user.expiresAt - Date.now(), 2_147_483_647)));
        expiry.unref();
        response.once("close", () => clearTimeout(expiry));
        let upstream;
        if (method === "POST" && ["/v1/responses", "/v1/responses/compact", "/v1/responses/input_tokens"].includes(url.pathname)) {
          noQuery(url);
          const body = await readJson(request);
          if (url.pathname === "/v1/responses") upstream = await responses.create(user.id, body, request.headers["idempotency-key"], options);
          else if (url.pathname.endsWith("/compact")) upstream = await responses.compact(user.id, body, options);
          else upstream = await responses.inputTokens(user.id, body, options);
        } else {
          const resource = url.pathname.match(/^\/v1\/responses\/(resp_[\w-]+)(?:\/(cancel|input_items))?$/);
          if (!resource) throw notFound();
          const [, id, action] = resource;
          if (method === "GET" && !action) upstream = await responses.retrieve(user.id, id, responseQuery(url), options);
          else if (method === "GET" && action === "input_items") upstream = await responses.inputItems(user.id, id, responseQuery(url, true), options);
          else if (method === "DELETE" && !action) { noQuery(url); upstream = await responses.delete(user.id, id, options); }
          else if (method === "POST" && action === "cancel") {
            noQuery(url);
            if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) > 0) fields(await readJson(request), [], null);
            upstream = await responses.cancel(user.id, id, options);
          } else throw notFound();
        }
        return await relayResponse(upstream, response, options);
      }

      // This user opens one of their Foundation requests: a single-use link, made only once we know who they are.
      if (isFoundation) {
        if (method !== "POST") throw notFound();
        if (!foundation?.enabled) throw notFound();
        noQuery(url);
        const body = await readJson(request);
        fields(body, ["request_id"], null);
        if (typeof body.request_id !== "string") throw invalid("request_id is required.", "request_id");
        return sendJson(response, 200, { url: await foundation.link(user.id, body.request_id) });
      }
      if (method === "GET" && url.pathname === "/api/billing") {
        noQuery(url);
        return sendJson(response, 200, { ...await billing.balance(user.id, options), pricing_status: "unconfigured" });
      }
      if (method === "GET" && url.pathname === "/api/billing/entries") {
        const query = listQuery(url);
        if (query.order !== undefined) throw invalid("Unsupported parameter.", "order");
        return sendJson(response, 200, await billing.history(user.id, query, options));
      }

      if (method === "GET" && url.pathname === PREFIX) {
        const query = listQuery(url, ["agent_id"]);
        return sendJson(response, 200, await sessions.list(user.id, query, options));
      }
      if (method === "POST" && url.pathname === PREFIX) {
        noQuery(url);
        return sendJson(response, 200, await sessions.create(user.id, await readJson(request)));
      }

      const match = url.pathname.match(/^\/v1\/agents\/sessions\/([\w-]+)(?:\/(items|turns|events)(?:\/([\w-]+))?)?$/);
      if (match) {
        const [, sessionId, resource, resourceId] = match;
        const session = await sessions.owned(user.id, sessionId, options);
        if (method === "GET" && !resource) {
          noQuery(url);
          return sendJson(response, 200, await session.retrieve(options));
        }
        if (method === "GET" && ["items", "turns"].includes(resource) && !resourceId) {
          return sendJson(response, 200, await session[resource](listQuery(url), options));
        }
        if (method === "GET" && resource === "turns" && resourceId) {
          noQuery(url);
          return sendJson(response, 200, await session.turn(resourceId, options));
        }
        if (resource === "events" && !resourceId) {
          noQuery(url);
          if (method === "GET") {
            // A subscription cannot outlive the credential that opened it.
            // Closing it never stops the agent; the refreshed client reconnects.
            const expiry = setTimeout(() => { controller.abort(); response.destroy(); }, Math.max(1, Math.min(user.expiresAt - Date.now(), 2_147_483_647)));
            expiry.unref();
            response.once("close", () => clearTimeout(expiry));
            const upstream = await session.stream(options);
            if (!upstream.headers.get("content-type")?.startsWith("text/event-stream") || !upstream.body) {
              throw Object.assign(new Error("Expected an event stream."), { status: 502 });
            }
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              "x-accel-buffering": "no",
            });
            response.flushHeaders();
            // Backpressure is bounded by Node's writable buffer. Disconnecting a
            // viewer closes only this subscription; it never sends input.cancel.
            for await (const chunk of upstream.body) {
              if (!response.write(chunk)) await once(response, "drain", options);
            }
            return response.end();
          }
          if (method === "POST") {
            const body = await readJson(request);
            validateEvents(body);
            const key = request.headers["idempotency-key"];
            if (key !== undefined && (typeof key !== "string" || !/^[\x21-\x7e]{1,256}$/.test(key))) {
              throw invalid("Invalid Idempotency-Key header.", "Idempotency-Key");
            }
            await session.submit(body.events, key, options);
            response.writeHead(204, { "cache-control": "no-store" });
            return response.end();
          }
        }
      }

      const asset = method === "GET" && PUBLIC_ASSETS.get(url.pathname);
      if (asset) {
        const content = await readFile(new URL(asset[0] === "app.js" ? "../.build/app.js" : `../public/${asset[0]}`, import.meta.url));
        response.writeHead(200, { "content-type": `${asset[1]}; charset=utf-8`, "cache-control": "no-cache" });
        return response.end(content);
      }
      throw notFound();
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = error.status ?? 502;
      if (status === 401 && !response.headersSent) response.setHeader("WWW-Authenticate", "Bearer");
      if (status >= 500) logger.error({
        event: "api_request_error", type: error.name, status,
        code: error.code ?? null, requestId: error.requestID ?? null,
      });
      // A transport failure is not a made-up terminal turn event.
      if (response.headersSent) return response.destroy();
      for (const name of ["retry-after", "retry-after-ms", "x-should-retry", "x-request-id"]) {
        const value = error.headers?.get(name);
        if (value !== null && value !== undefined) response.setHeader(name, value);
      }
      sendJson(response, status, { error: {
        message: error.local ? error.message : "The request could not be completed.",
        type: error.type ?? (status >= 500 ? "server_error" : "invalid_request_error"),
        param: error.param ?? null,
        code: error.code ?? null,
      } });
    }
  });
}

async function relayResponse(upstream, response, options) {
  if (response.destroyed) { await upstream.body?.cancel(); return; }
  const stream = upstream.headers.get("content-type")?.startsWith("text/event-stream");
  for (const name of ["content-type", "x-request-id", "retry-after", "retry-after-ms", "x-should-retry"]) {
    const value = upstream.headers.get(name);
    if (value !== null) response.setHeader(name, value);
  }
  response.setHeader("cache-control", stream ? "no-cache, no-transform" : "no-store");
  if (stream) response.setHeader("x-accel-buffering", "no");
  response.writeHead(upstream.status);
  response.flushHeaders();
  if (upstream.body) for await (const chunk of upstream.body) {
    if (!response.write(chunk)) await once(response, "drain", options);
  }
  response.end();
}

function responseQuery(url, items = false) {
  const query = {};
  const allowed = items ? ["include", "after", "limit", "order"] : ["include", "stream", "starting_after", "include_obfuscation"];
  for (const [raw, value] of url.searchParams) {
    const key = raw === "include[]" ? "include" : raw;
    if (!allowed.includes(key) || (key !== "include" && Object.hasOwn(query, key))) throw invalid("Unsupported parameter.", raw);
    if (key === "include") (query.include ??= []).push(value);
    else if (["stream", "include_obfuscation"].includes(key)) {
      if (!["true", "false"].includes(value)) throw invalid("Expected a boolean.", key);
      query[key] = value === "true";
    } else if (["limit", "starting_after"].includes(key)) {
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < (key === "limit" ? 1 : 0) || (key === "limit" && number > 100)) throw invalid("Invalid integer.", key);
      query[key] = number;
    } else {
      if (!value || (key === "order" && !["asc", "desc"].includes(value))) throw invalid("Invalid parameter.", key);
      query[key] = value;
    }
  }
  return query;
}

function listQuery(url, extra = []) {
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (!["after", "limit", "order", ...extra].includes(key) || key in query) throw invalid("Unsupported parameter.", key);
    if (key === "limit") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw invalid("limit must be between 1 and 100.", key);
      query.limit = Number(value);
    } else {
      if (!value || (key === "order" && !["asc", "desc"].includes(value))) throw invalid("Invalid parameter.", key);
      query[key] = value;
    }
  }
  return query;
}

function noQuery(url) {
  if (url.search) throw invalid("Query parameters are not supported on this endpoint.");
}

function fields(value, names, param) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !names.includes(key))) {
    throw invalid("Unsupported fields or invalid object.", param);
  }
}

function validateEvents(body) {
  fields(body, ["events"], null);
  if (!Array.isArray(body.events) || body.events.length !== 1) throw invalid("Submit one input event at a time.", "events");
  const event = body.events[0];
  fields(event, event?.type === "agent.session.input.cancel" ? ["type"] : ["type", "input"], "events[0]");
  if (event.type === "agent.session.input.cancel") return;
  if (event.type !== "agent.session.input.message") throw invalid("This input event type is not supported.", "events[0].type");
  if (!Array.isArray(event.input) || !event.input.length) throw invalid("input must contain user messages.", "events[0].input");
  let characters = 0;
  for (const message of event.input) {
    fields(message, ["type", "role", "content"], "input");
    if (message.role !== "user" || (message.type !== undefined && message.type !== "message") || !Array.isArray(message.content) || !message.content.length) {
      throw invalid("Expected a user message with content.", "input");
    }
    for (const part of message.content) {
      fields(part, ["type", "text"], "content");
      if (part.type !== "input_text" || typeof part.text !== "string" || !part.text.trim()) {
        throw invalid("Only nonempty input_text content is supported.", "content");
      }
      characters += part.text.length;
    }
  }
  if (characters > 20_000) throw invalid("Input must not exceed 20000 characters.", "input");
}

// The body as sent, for a signature that covers its exact bytes.
async function readRaw(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(invalid("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request) {
  if (!request.headers["content-type"]?.split(";")[0].trim().match(/^application\/json$/i)) {
    throw Object.assign(invalid("Content-Type must be application/json."), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(invalid("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw invalid("Request body must be valid JSON."); }
}

function invalid(message, param) { return Object.assign(new Error(message), { status: 400, local: true, param }); }
function notFound() { return Object.assign(invalid("Not found."), { status: 404, code: "not_found" }); }
function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store",
  });
  response.end(body);
}
