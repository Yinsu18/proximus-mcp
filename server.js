const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 8080;

const DEMO_API_URL = process.env.DEMO_API_URL; // e.g. https://<demo>.onrender.com/api/data
const DEMO_API_KEY = process.env.DEMO_API_KEY; // shared secret for /api/data
const MCP_API_KEY = process.env.MCP_API_KEY || null;
const MCP_REQUIRE_KEY =
  (process.env.MCP_REQUIRE_KEY || "false").toLowerCase() === "true";

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

// ---- Optional bearer auth ----
function auth(req, res, next) {
  if (!MCP_REQUIRE_KEY) return next();
  const hdr = req.get("Authorization") || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!tok || !MCP_API_KEY)
    return res.status(401).json({ error: "missing/invalid token" });
  const ok = crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(MCP_API_KEY));
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/healthz", (req, res) => res.send("ok"));

app.post("/query", auth, async (req, res) => {
  try {
    if (!DEMO_API_URL)
      return res.status(500).json({ error: "DEMO_API_URL not set" });
    const { resource, filters } = req.body || {};
    if (!resource)
      return res.status(400).json({ error: "resource is required" });

    // build demo URL with filters
    const qs = new URLSearchParams();
    if (filters?.country) qs.set("country", filters.country);
    if (filters?.status) qs.set("status", filters.status);
    const url = DEMO_API_URL.replace(/\/?$/, "") + "?" + qs.toString();

    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-API-Key": DEMO_API_KEY,
      },
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(502).json({ error: "upstream demo error", details: txt });
    }
    const rows = await resp.json();

    function kpis(rows) {
      const total = rows.length;
      const delivered = rows.filter((r) => r.status === "DELIVERED").length;
      const failed = rows.filter((r) => r.status === "FAILED").length;
      const blocked = rows.filter((r) => r.status === "BLOCKED").length;
      const avgLatency = total
        ? rows.reduce((a, b) => a + b.latency_ms, 0) / total
        : 0;
      return { total, delivered, failed, blocked, avgLatency };
    }

    if (resource === "kpis") {
      return res.json({ ok: true, data: kpis(rows) });
    }
    if (resource === "records") {
      return res.json({ ok: true, data: rows.slice(0, 200) });
    }
    return res.status(400).json({ error: "unknown resource", resource });
  } catch (e) {
    res
      .status(500)
      .json({ error: "internal error", details: String(e?.message || e) });
  }
});

app.get("/", (req, res) => res.type("text").send("Proximus MCP running. POST /query"));

app.listen(PORT, () => console.log(`mcp-server running on port ${PORT}`));
