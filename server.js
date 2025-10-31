// Minimal MCP WebSocket server (JSON-RPC 2.0 over WS)
// Tools: proximus.kpis, proximus.records
// Pulls rows from DEMO_API_URL (demo app /api/data) using X-API-Key

const http = require("http");
const url = require("url");
const express = require("express");
const cors = require("cors");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// ---- Integration with your demo app ----
const DEMO_API_URL = process.env.DEMO_API_URL; // e.g. https://<demo>.onrender.com/api/data
const DEMO_API_KEY = process.env.DEMO_API_KEY; // send as X-API-Key to demo

// ---- (Optional) Bearer auth for WS clients (ChatGPT MCP Connector) ----
const MCP_REQUIRE_KEY = (process.env.MCP_REQUIRE_KEY || "false").toLowerCase() === "true";
const MCP_API_KEY = process.env.MCP_API_KEY || null;

// ---- Express just for health check ----
const app = express();
app.disable("x-powered-by");
app.use(cors());
app.get("/healthz", (_req, res) => res.send("ok"));

const server = http.createServer(app);

// ---- WebSocket endpoint for MCP ----
const wss = new WebSocket.Server({ noServer: true });

app.get("/", (req, res) => res.send("MCP WS server ready. Connect via /mcp (WebSocket)."));
server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname !== "/mcp") {
    socket.destroy();
    return;
  }

  // Optional auth: Authorization: Bearer <token> OR ?key=<token>
  if (MCP_REQUIRE_KEY) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : (query?.key || "");
    const ok = token && MCP_API_KEY && token === MCP_API_KEY;
    if (!ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ---- Helpers ----
function jsonrpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function jsonrpcError(id, code, message, data) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } });
}
function asNumber(n, def) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : def;
}

// Fetch rows from demo app with filters
async function fetchRows(filters = {}, limit = 1000) {
  if (!DEMO_API_URL) throw new Error("DEMO_API_URL not set");
  const qs = new URLSearchParams();
  if (filters.country) qs.set("country", String(filters.country));
  if (filters.status) qs.set("status", String(filters.status));
  qs.set("limit", String(limit));
  const url = DEMO_API_URL.replace(/\/?$/, "") + "?" + qs.toString();

  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(DEMO_API_KEY ? { "X-API-Key": DEMO_API_KEY } : {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Demo upstream ${resp.status}: ${text}`);
  }
  return await resp.json();
}

function computeKpis(rows) {
  const total = rows.length;
  const delivered = rows.filter((r) => r.status === "DELIVERED").length;
  const failed = rows.filter((r) => r.status === "FAILED").length;
  const blocked = rows.filter((r) => r.status === "BLOCKED").length;
  const avgLatency = total ? rows.reduce((a, b) => a + b.latency_ms, 0) / total : 0;
  return { total, delivered, failed, blocked, avgLatency };
}

// ---- MCP session ----
wss.on("connection", (ws) => {
  // Basic keepalive
  const pingIv = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

  ws.on("close", () => clearInterval(pingIv));

  ws.on("message", async (msg) => {
    let req;
    try {
      req = JSON.parse(msg.toString());
    } catch {
      // Not JSON-RPC — ignore
      return;
    }

    const { id, method, params } = req || {};
    if (!method) return;

    try {
      // --- MCP handshake: initialize ---
      if (method === "initialize") {
        // minimal MCP response
        const result = {
          protocolVersion: "2024-11-05", // nominal string; clients ignore exact date
          serverInfo: {
            name: "proximus-mcp",
            version: "1.0.0",
          },
          capabilities: {
            tools: {}, // we support tools/list and tools/call
          },
        };
        ws.send(jsonrpcResult(id, result));
        return;
      }

      // --- Tool discovery ---
      if (method === "tools/list") {
        const tools = [
          {
            name: "proximus.kpis",
            description:
              "Compute delivery KPIs from the Proximus demo data (sourced from /api/data).",
            inputSchema: {
              type: "object",
              properties: {
                country: { type: "string", description: "2-letter country code" },
                status: {
                  type: "string",
                  enum: ["DELIVERED", "FAILED", "BLOCKED", "PENDING"],
                },
                limit: { type: "integer", minimum: 1, maximum: 1000, default: 1000 },
              },
            },
          },
          {
            name: "proximus.records",
            description:
              "Return up to 'limit' records from the Proximus demo data (for custom analysis).",
            inputSchema: {
              type: "object",
              properties: {
                country: { type: "string" },
                status: {
                  type: "string",
                  enum: ["DELIVERED", "FAILED", "BLOCKED", "PENDING"],
                },
                limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
              },
            },
          },
        ];
        ws.send(jsonrpcResult(id, { tools }));
        return;
      }

      // --- Tool execution ---
      if (method === "tools/call") {
        const { name, arguments: args = {} } = params || {};
        if (!name) {
          ws.send(jsonrpcError(id, -32602, "Tool name missing"));
          return;
        }

        // Normalize inputs
        const filters = {};
        if (args.country) filters.country = String(args.country);
        if (args.status) filters.status = String(args.status);
        const limit = asNumber(args.limit, name === "proximus.kpis" ? 1000 : 200);

        if (name === "proximus.kpis") {
          const rows = await fetchRows(filters, limit);
          const k = computeKpis(rows);
          // Return as text content (widely supported by clients)
          ws.send(
            jsonrpcResult(id, {
              content: [
                {
                  type: "text",
                  text:
                    "KPIs (from demo data): " +
                    JSON.stringify(k),
                },
              ],
              // Some clients also look for a JSON blob:
              data: k,
            })
          );
          return;
        }

        if (name === "proximus.records") {
          const rows = await fetchRows(filters, limit);
          ws.send(
            jsonrpcResult(id, {
              content: [
                {
                  type: "text",
                  text:
                    "Records (subset) from demo data: " +
                    JSON.stringify(rows.slice(0, limit)),
                },
              ],
              data: rows.slice(0, limit),
            })
          );
          return;
        }

        ws.send(jsonrpcError(id, -32601, `Unknown tool: ${name}`));
        return;
      }

      // --- Optional: basic ping/pong via JSON-RPC ---
      if (method === "ping") {
        ws.send(jsonrpcResult(id, { ok: true }));
        return;
      }

      // Unimplemented
      ws.send(jsonrpcError(id, -32601, `Unknown method: ${method}`));
    } catch (e) {
      ws.send(jsonrpcError(id, -32000, "Internal error", String(e?.message || e)));
    }
  });

  // Some clients send notifications like "initialized"
  ws.on("error", () => {});
});

server.listen(PORT, () => {
  console.log(`MCP WS listening on :${PORT} (path /mcp)`);
  console.log(`Health: GET http://0.0.0.0:${PORT}/healthz`);
});
