/**
 * HTTP and static-file adapter for ONNXTTS.
 *
 * The module owns transport concerns only: routing, request size limits,
 * security headers, JSON responses, and safe file streaming. Model and
 * synthesis operations are injected as services by `server.mjs`.
 */
import http from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
]);

// These headers apply to API, static, preview, and download responses.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function sendJson(response, status, value) {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message, detail) {
  sendJson(response, status, { error: message, ...(detail ? { detail } : {}) });
}

/** Reads a bounded JSON request body and attaches an HTTP status to errors. */
async function readJson(request, limit = 128 * 1024) {
  let size = 0;
  const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    parts.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400 });
  }
}

/** Streams a known local file with the same security policy as API responses. */
async function streamFile(response, filePath, options = {}) {
  const fileStats = await stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": CONTENT_TYPES.get(extension) || "application/octet-stream",
    "Content-Length": fileStats.size,
    "Cache-Control": options.cache || "no-cache",
    ...(options.downloadName ? { "Content-Disposition": `attachment; filename="${options.downloadName.replace(/["\\\r\n]/g, "_")}"` } : {}),
  });
  createReadStream(filePath).pipe(response);
}

/** Resolves a URL segment without allowing traversal outside its root. */
function safeChild(root, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const fullPath = path.resolve(root, decoded.replace(/^[/\\]+/, ""));
  const relative = path.relative(path.resolve(root), fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return fullPath;
}

/**
 * Builds the Node HTTP server. The returned server is not listening yet, so
 * `server.mjs` remains responsible for startup logs and graceful shutdown.
 */
export function createWebServer({
  host,
  port,
  publicRoot,
  audioRoot,
  defaultHfToken,
  runtimeStatus,
  services,
}) {
  const {
    scanModels,
    toPublicModel,
    inspectHuggingFace,
    installModel,
    uploadCustomModel,
    generateAudio,
  } = services;

  async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    try {
      // Runtime and model-library status.
      if (request.method === "GET" && url.pathname === "/api/health") {
        const models = await scanModels();
        return sendJson(response, 200, {
          ok: true,
          localOnly: host === "127.0.0.1" || host === "localhost",
          models: models.length,
          runtime: runtimeStatus(),
        });
      }

      // Model discovery, remote installation, and local custom uploads.
      if (request.method === "GET" && url.pathname === "/api/models") {
        return sendJson(response, 200, { models: (await scanModels()).map(toPublicModel) });
      }
      if (request.method === "POST" && url.pathname === "/api/models/inspect") {
        const body = await readJson(request);
        const result = await inspectHuggingFace(body.url, body.token || defaultHfToken);
        return sendJson(response, 200, { repoId: result.repoId, revision: result.revision, candidates: result.candidates });
      }
      if (request.method === "POST" && url.pathname === "/api/models/download") {
        const body = await readJson(request);
        const installed = await installModel(body.url, body.token || defaultHfToken);
        const models = await scanModels();
        const model = models.find((item) => path.resolve(item._path).toLowerCase() === path.resolve(installed.modelPath).toLowerCase());
        return sendJson(response, 200, { alreadyInstalled: installed.alreadyInstalled, model: model ? toPublicModel(model) : null });
      }
      if (request.method === "POST" && url.pathname === "/api/models/upload") {
        const uploaded = await uploadCustomModel(request);
        const models = await scanModels();
        const model = models.find((item) => path.resolve(item._path).toLowerCase() === path.resolve(uploaded.modelPath).toLowerCase());
        return sendJson(response, 201, { model: model ? toPublicModel(model) : null });
      }

      // Synthesis is delegated to the isolated ONNX runtime module.
      if (request.method === "POST" && url.pathname === "/api/generate") {
        return sendJson(response, 200, await generateAudio(await readJson(request)));
      }

      // Generated audio supports inline preview and forced download endpoints.
      if (request.method === "GET" && url.pathname.startsWith("/media/")) {
        const filePath = safeChild(audioRoot, url.pathname.slice("/media/".length));
        if (!filePath || !existsSync(filePath)) return sendError(response, 404, "Audio file not found");
        return streamFile(response, filePath, { cache: "private, max-age=3600" });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/download/")) {
        const filePath = safeChild(audioRoot, url.pathname.slice("/api/download/".length));
        if (!filePath || !existsSync(filePath)) return sendError(response, 404, "Audio file not found");
        const extension = path.extname(filePath).toLowerCase();
        return streamFile(response, filePath, { downloadName: `onnxtts-${Date.now()}${extension}` });
      }

      // All remaining GET requests are treated as public UI assets.
      if (request.method === "GET") {
        const requestPath = url.pathname === "/" ? "index.html" : url.pathname;
        const filePath = safeChild(publicRoot, requestPath);
        if (filePath && existsSync(filePath) && (await stat(filePath)).isFile()) return streamFile(response, filePath, { cache: "no-cache" });
      }

      return sendError(response, 404, "Not found");
    } catch (error) {
      console.error(error);
      return sendError(
        response,
        error.statusCode || 500,
        error.statusCode ? error.message : "The local server could not complete this request",
        error.statusCode ? undefined : error.message,
      );
    }
  }

  return http.createServer(handleRequest);
}