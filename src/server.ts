import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 3456);

// stderr is swallowed by Claude Code when running as an MCP subprocess, so also
// append to a log file the user can `tail -f` regardless of transport.
const LOG_FILE = resolve(process.env.LOG_FILE ?? "debug.log");

/** Log to both stderr and the log file (stderr alone isn't visible under Claude Code). */
function log(...parts: unknown[]) {
  const line = parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p, null, 2)))
    .join(" ");
  console.error(line);
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort; never fail the tool call because logging failed
  }
}

/** Extract the trace_id (2nd field) from a W3C traceparent: "00-{traceId}-{spanId}-{flags}". */
function extractTraceId(traceparent: string | undefined): string | undefined {
  if (!traceparent) return undefined;
  const parts = traceparent.split("-");
  // version-traceId-spanId-flags
  if (parts.length >= 2 && /^[0-9a-f]{32}$/i.test(parts[1])) {
    return parts[1];
  }
  return undefined;
}

async function handleEcho(
  args: { message: string },
  extra: RequestHandlerExtra<any, any>,
) {
  const meta = extra._meta ?? {};

  // --- debug logging of traceparent propagation ---
  const requestHeaders = extra.requestInfo?.headers ?? null;
  const traceparentRawFromMeta = (meta as Record<string, unknown>).traceparent;
  const traceparentFromHeader = requestHeaders?.["traceparent"];
  // NOTE: Claude Code does not send the traceparent in _meta, but it does send it in the HTTP header. So we check both places.
  const traceparent =
    typeof traceparentRawFromMeta === "string"
      ? traceparentRawFromMeta
      : typeof traceparentFromHeader === "string"
        ? traceparentFromHeader
        : undefined;
  const propagatedTraceId = extractTraceId(traceparent);

  log("=== echo called ===");
  log("message:", args.message);
  log("_meta:", meta);
  if (requestHeaders) {
    log("request headers:", requestHeaders);
  }
  log("traceparent:", traceparent);
  log("traceId:", propagatedTraceId);

  return {
    content: [{ type: "text" as const, text: args.message }],
    _meta: {
      "traceparent/trace_id": propagatedTraceId,
    },
  };
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "echo-traceparent",
    version: "0.1.0",
  });

  server.registerTool(
    "echo",
    {
      description:
        "Echo back the input message. Parses _meta / HTTP headers to extract the W3C traceparent and records it to the debug log.",
      inputSchema: { message: z.string() },
    },
    handleEcho,
  );

  return server;
}

async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`[echo-traceparent] stdio transport ready (log file: ${LOG_FILE})`);
}

async function runHttp() {
  // Stateless mode: new server+transport per request.
  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // Reject session-based requests: stateless server has no sessions.
      if (req.headers["mcp-session-id"]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Session not found (stateless server)",
            },
            id: null,
          }),
        );
        return;
      }

      if (req.method === "POST") {
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } catch (err) {
          log("[echo-traceparent] request error:", String(err));
          if (!res.headersSent) {
            res.writeHead(500).end();
          }
        }
        return;
      }

      // GET/DELETE not supported in stateless mode.
      res.writeHead(405, { Allow: "POST" }).end();
    },
  );

  httpServer.listen(PORT, () => {
    log(
      `[echo-traceparent] HTTP transport ready on http://localhost:${PORT} (log file: ${LOG_FILE})`,
    );
  });
}

const transport = process.env.TRANSPORT ?? "http";
if (transport === "http") {
  await runHttp();
} else if (transport === "stdio") {
  await runStdio();
} else {
  log(
    `[echo-traceparent] unknown TRANSPORT=${transport}, expected "http" or "stdio"`,
  );
  process.exit(1);
}
