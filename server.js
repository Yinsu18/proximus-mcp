// repo layout (suggested)
// / (root)
// ├─ server.js        ← MCP implementation
// ├─ package.json
// ├─ render.yaml      ← Render Blueprint (optional one-click)
// └─ README.md

// ============================== server.js ==============================
// Minimal Proximus MCP server for Render. Node/Express, single file.
// Exposes POST /query that accepts { prompt, resource, filters } and returns JSON.
// - Optional Bearer API key check via MCP_API_KEY (and MCP_REQUIRE_KEY=true)
// - Health check at /healthz
// - CORS enabled (safe default)
// - Basic rate limiting
// - Mock data generation so you can demo without upstream Proximus API

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 8080;
const MCP_API_KEY = process.env.MCP_API_KEY || null; // value to compare
const MCP_REQUIRE_KEY = (process.env.MCP_REQUIRE_KEY || 'false').toLowerCase() === 'true';

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- simple rate limit ---
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 120 });
app.use(limiter);

// --- auth middleware (optional) ---
function checkAuth(req, res, next) {
  if (!MCP_REQUIRE_KEY) return next();
  const hdr = req.get('Authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token || !MCP_API_KEY) {
    return res.status(401).json({ error: 'missing or invalid Authorization bearer token' });
  }
  // constant-time compare
  const ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(MCP_API_KEY));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// --- health ---
app.get('/healthz', (req, res) => res.send('ok'));

// --- mock data helpers ---
const COUNTRIES = ['US','GB','DE','FR','BR','IN','MX','CO','ES','IT'];
const CARRIERS = ['TeleOne','GlobalTel','SkyMobile','ProNet'];
const STATUSES = ['DELIVERED','FAILED','BLOCKED','PENDING'];

function makeMockRows(n = 300) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: crypto.randomUUID(),
      country: COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)],
      carrier: CARRIERS[Math.floor(Math.random() * CARRIERS.length)],
      status: STATUSES[Math.floor(Math.random() * STATUSES.length)],
      latency_ms: Math.floor(Math.random() * 3000) + 100,
      message: 'Hello from Proximus MCP',
      timestamp: Date.now() - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 7)
    });
  }
  return out;
}

function filterRows(rows, filters = {}) {
  let out = rows;
  if (filters.country) out = out.filter(r => r.country === String(filters.country).toUpperCase());
  if (filters.status) out = out.filter(r => r.status === String(filters.status).toUpperCase());
  return out;
}

function computeKpis(rows) {
  const total = rows.length;
  const delivered = rows.filter(r => r.status === 'DELIVERED').length;
  const failed = rows.filter(r => r.status === 'FAILED').length;
  const blocked = rows.filter(r => r.status === 'BLOCKED').length;
  const avgLatency = total ? rows.reduce((a, b) => a + b.latency_ms, 0) / total : 0;
  return { total, delivered, failed, blocked, avgLatency };
}

// --- main MCP endpoint ---
app.post('/query', checkAuth, async (req, res) => {
  try {
    const { prompt, resource, filters } = req.body || {};
    if (!resource) return res.status(400).json({ error: 'resource is required' });

    // For demo: generate mock rows and apply filters
    const allRows = makeMockRows(600);
    const rows = filterRows(allRows, filters);

    let data;
    if (resource === 'kpis') {
      data = computeKpis(rows);
    } else if (resource === 'messages') {
      data = rows.slice(0, 200);
    } else {
      return res.status(400).json({ error: 'unknown resource', resource });
    }

    // Provide context to help the LLM reason about the shape
    const context = {
      note: 'Proximus MCP demo response. Fields: country, carrier, status, latency_ms, timestamp. Status in {DELIVERED,FAILED,BLOCKED,PENDING}.',
      filters: filters || null,
      resource
    };

    res.json({ ok: true, context, data });
  } catch (e) {
    console.error('MCP /query error', e);
    res.status(500).json({ error: 'internal error', details: String(e && e.message || e) });
  }
});

// --- root ---
app.get('/', (req, res) => {
  res.type('text').send('Proximus MCP is running. POST /query');
});

app.listen(PORT, () => console.log(`MCP listening on :${PORT}`));
