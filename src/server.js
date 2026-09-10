import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGE_CHARACTERS = 20_000;
const PUBLIC_DIRECTORY = new URL("../public/", import.meta.url);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createServer({ conversation, logger = console }) {
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/messages") {
        const messages = await conversation.messages();
        return sendJson(response, 200, { messages });
      }

      if (request.method === "POST" && url.pathname === "/api/messages") {
        const body = await readJson(request);
        const text = typeof body.text === "string" ? body.text.trim() : "";

        if (!text) {
          return sendJson(response, 400, { error: "Message text is required." });
        }
        if (text.length > MAX_MESSAGE_CHARACTERS) {
          return sendJson(response, 400, { error: "Message text is too long." });
        }

        return streamMessage({ conversation, logger, response, text });
      }

      if (request.method === "GET") {
        return serveStatic(url.pathname, response);
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const status = error.statusCode ?? 500;
      if (status >= 500) {
        logger.error(error);
      }
      sendJson(response, status, {
        error: status >= 500 ? "The conversation is unavailable right now." : error.message,
      });
    }
  });
}

async function streamMessage({ conversation, logger, response, text }) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  try {
    const message = await conversation.send(text, {
      onDelta(delta) {
        sendEvent(response, "delta", { text: delta });
      },
    });
    sendEvent(response, "done", { message });
  } catch (error) {
    logger.error(error);
    sendEvent(response, "error", {
      error: "The conversation is unavailable right now.",
    });
  } finally {
    response.end();
  }
}

function sendEvent(response, event, value) {
  if (response.destroyed) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

async function serveStatic(pathname, response) {
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, "");

  try {
    const content = await readFile(new URL(safePath, PUBLIC_DIRECTORY));
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(safePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      return sendJson(response, 404, { error: "Not found." });
    }
    throw error;
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}
