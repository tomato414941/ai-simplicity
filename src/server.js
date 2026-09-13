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
        return sendJson(response, 200, await conversation.snapshot());
      }

      if (request.method === "POST" && url.pathname === "/api/messages") {
        const body = await readJson(request);
        if (typeof body.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.id)) {
          return sendJson(response, 400, { error: "送信内容を確認できませんでした。" });
        }
        const text = typeof body.text === "string" ? body.text.trim() : "";

        if (!text) {
          return sendJson(response, 400, { error: "メッセージを入力してください。" });
        }
        if (text.length > MAX_MESSAGE_CHARACTERS) {
          return sendJson(response, 400, { error: "メッセージを短くしてください。" });
        }

        return sendJson(response, 202, await conversation.send({ id: body.id, text }));
      }

      if (request.method === "POST" && url.pathname === "/api/retry") {
        const body = await readJson(request);
        if (typeof body.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.id)) return sendJson(response, 400, { error: "送信内容を確認できませんでした。" });
        return sendJson(response, 202, await conversation.retry(body.id));
      }

      if (request.method === "POST" && url.pathname === "/api/stop") {
        const body = await readJson(request);
        if (typeof body.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.id)) return sendJson(response, 400, { error: "送信内容を確認できませんでした。" });
        return sendJson(response, 202, await conversation.stop(body.id));
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
        error: status >= 500 ? "今は会話を確認できません。" : error.message,
      });
    }
  });
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
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
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
