import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";

const MAX_BODY_BYTES = 128 * 1024;
const PREFIX = "/v1/agents/sessions";
const PUBLIC_ASSETS = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/agent-session.js", ["agent-session.js", "text/javascript"]],
  ["/styles.css", ["styles.css", "text/css"]],
]);

export function createServer({ session, logger = console }) {
  return createHttpServer(async (request, response) => {
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    const options = { signal: controller.signal };
    try {
      const url = new URL(request.url, "http://localhost");
      const method = request.method;
      if (method === "GET" && url.pathname === "/api/health") return sendJson(response, 200, { ok: true });

      if (method === "GET" && url.pathname === PREFIX) {
        const query = listQuery(url, ["agent_id"]);
        if (query.after && query.after !== session.id) throw invalid("Unknown cursor.", "after");
        return sendJson(response, 200, await session.list(query, options));
      }

      const match = url.pathname.match(/^\/v1\/agents\/sessions\/([\w-]+)(?:\/(items|turns|events)(?:\/([\w-]+))?)?$/);
      if (match) {
        const [, sessionId, resource, resourceId] = match;
        if (sessionId !== session.id) throw notFound();
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
            if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
              throw Object.assign(invalid("Origin is not allowed."), { status: 403 });
            }
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
        const content = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
        response.writeHead(200, { "content-type": `${asset[1]}; charset=utf-8`, "cache-control": "no-cache" });
        return response.end(content);
      }
      throw notFound();
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = error.status ?? 502;
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
