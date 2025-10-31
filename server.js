// Minimal MCP WebSocket server (JSON-RPC 2.0 over WS)
// Tools: proximus.kpis, proximus.records
// Pulls rows from DEMO_API_URL (/api/data) using X-API-Key

const http = require("http");
const url = require("url");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 8080;

// --- Demo app integration
const DEMO_API_URL = process.env.DEMO_API_URL; // e.g. https://<demo>.onrender.com/api/data
const DEMO_API_KEY = process.env.DEMO_API_KEY; // shared secret sent as X-API-Key

// --- Optional bearer auth for WS clients
const MCP_REQUIRE_KEY = (process.env.MCP_REQUIRE_KEY || "false").toLowerCase() === "true";
const MCP_API_KEY = process.env.MCP_API_KEY || null;

const app = express();
app.disable("x-powered-by");
app.use(cors());

// Health + simple root (lets HTTPS validators succeed)
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => {
  res.json({
    message: "Proximus MCP ready. This endpoint upgrades to WebSocket for MCP protocol.",
    wsPath: "/mcp"
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({
  noServer: true,
  handleProtocols: (protocols /* Set<string> */, req) => {
    if (protocols.includes('mcp')) return 'mcp';
    if (protocols.includes('jsonrpc')) return 'jsonrpc';
    return false; // no match; some clients will still proceed without a subprotocol
  }
});
// --- WebSocket upgrade handler; accept "/" and "/mcp" and negotiate subprotocol
server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname !== "/" && pathname !== "/mcp") {
    socket.destroy();
    return;
  }

  // Optional auth via ?key= or Authorization header
  if (MCP_REQUIRE_KEY) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : (query && query.key) || "";
    const ok = token && MCP_API_KEY && token === MCP_API_KEY;
    if (!ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  // --- Subprotocol negotiation (important for MCP clients) ---
  const requested = (req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  // Prefer 'mcp', then 'jsonrpc', else echo nothing (some clients don't require it)
  const chosen =
    requested.includes("mcp") ? "mcp" :
    requested.includes("jsonrpc") ? "jsonrpc" :
    undefined;

  // When a subprotocol is chosen, we must include it in the upgrade response.
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Monkey-patch the protocol on the ws object so downstream can read ws.protocol
    if (chosen) ws.protocol = chosen;
    wss.emit("connection", ws, req);
  });

  // If you want to explicitly send chosen subprotocol in response headers, use:
  // NOTE: The 'ws' package does not expose a direct API to set headers here,
  // but most clients accept this implicit selection. If you need strict echoing,
  // switch to the 'handleProtocols' option on WebSocket.Server:
  // const wss = new WebSocket.Server({
  //   noServer: true,
  //   handleProtocols: (protocols, req) => (protocols.includes('mcp') ? 'mcp' :
  //                                        protocols.includes('jsonrpc') ? 'jsonrpc' : false)
  // });
});

// ---- Helpers
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
async function fetchRows(filters = {}, limit = 1000) {
  if (!DEMO_API_URL) throw new Error("DEMO_API_URL not set");
  const qs = new URLSearchParams();
  if (filters.country) qs.set("country", String(filters.country));
  if (filters.status) qs.set("status", String(filters.status));
  qs.set("limit", String(limit));
  const u = DEMO_API_URL.replace(/\/?$/, "") + "?" + qs.toString();

  const resp = await fetch(u, {
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

// ---- MCP session
wss.on("connection", (ws) => {
  const pingIv = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);
  ws.on("close", () => clearInterval(pingIv));
  ws.on("error", () => {});

  ws.on("message", async (msg) => {
    let req;
    try {
      req = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const { id, method, params } = req || {};
    if (!method) return;

    try {
      // Handshake
      if (method === "initialize") {
        const result = {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "proximus-mcp", version: "1.0.0" },
          capabilities: { tools: {} }
        };
        ws.send(jsonrpcResult(id, result));
        return;
      }

      // List tools
      if (method === "tools/list") {
        const tools = [
          {
            name: "proximus.kpis",
            description: "Compute delivery KPIs from the Proximus demo data (/api/data).",
            inputSchema: {
              type: "object",
              properties: {
                country: { type: "string" },
                status: { type: "string", enum: ["DELIVERED","FAILED","BLOCKED","PENDING"] },
                limit: { type: "integer", minimum: 1, maximum: 1000, default: 1000 }
              }
            }
          },
          {
            name: "proximus.records",
            description: "Return up to 'limit' records from the demo data for analysis.",
            inputSchema: {
              type: "object",
              properties: {
                country: { type: "string" },
                status: { type: "string", enum: ["DELIVERED","FAILED","BLOCKED","PENDING"] },
                limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 }
              }
            }
          }
        ];
        ws.send(jsonrpcResult(id, { tools }));
        return;
      }

      // Call tool
      if (method === "tools/call") {
        const { name, arguments: args = {} } = params || {};
        if (!name) {
          ws.send(jsonrpcError(id, -32602, "Tool name missing"));
          return;
        }

        const filters = {};
        if (args.country) filters.country = String(args.country);
        if (args.status) filters.status = String(args.status);
        const limit = asNumber(args.limit, name === "proximus.kpis" ? 1000 : 200);

        if (name === "proximus.kpis") {
          const rows = await fetchRows(filters, limit);
          const k = computeKpis(rows);
          ws.send(jsonrpcResult(id, {
            content: [{ type: "text", text: "KPIs: " + JSON.stringify(k) }],
            data: k
          }));
          return;
        }

        if (name === "proximus.records") {
          const rows = await fetchRows(filters, limit);
          const subset = rows.slice(0, limit);
          ws.send(jsonrpcResult(id, {
            content: [{ type: "text", text: "Records: " + JSON.stringify(subset) }],
            data: subset
          }));
          return;
        }

        ws.send(jsonrpcError(id, -32601, `Unknown tool: ${name}`));
        return;
      }

      // Optional ping
      if (method === "ping") {
        ws.send(jsonrpcResult(id, { ok: true }));
        return;
      }

      ws.send(jsonrpcError(id, -32601, `Unknown method: ${method}`));
    } catch (e) {
      ws.send(jsonrpcError(id, -32000, "Internal error", String(e?.message || e)));
    }
  });
});

server.listen(PORT, () => {
  console.log(`MCP WS listening on :${PORT} (paths / and /mcp)`);
  console.log(`Health: GET http://0.0.0.0:${PORT}/healthz`);
});
