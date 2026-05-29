// server/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Express proxy server
//   GET  /api/utilisation       → RAW data (teams + engineers) for dashboard
//   GET  /api/health            → health + cache status
//   GET  /api/debug-week        → fetch ONE week's report (fast test)
//   POST /api/claude            → forwards to Claude (if AI panel enabled)
//   GET  /                      → serves the dashboard
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fetch   = require('node-fetch');

const { authenticate, fetchReportRange } = require('./resourceGuru');
const { buildRawData } = require('./transformer');

const app  = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '360', 10); // default 1 hour

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── In-memory cache ──────────────────────────────────────────────────────────
let cache = { data: null, fetchedAt: null, expiresAt: null, building: false };
const isCacheValid = () => cache.data && cache.expiresAt && new Date() < cache.expiresAt;

// Date range for the dashboard: this year's W14-ish onward. We use the
// current year Jan→Dec but only weeks with bookings will show real numbers.
function getDateRange() {
  const now = new Date();
  const year = now.getFullYear();
  // Match the original dashboard span: April (W14) to early October (W40).
  // Adjust here if you want a different window.
  const from = `${year}-04-01`;
  const to   = `${year}-10-03`;
  return { from, to };
}

async function refreshCache() {
  if (cache.building) {
    console.log('[Cache] Build already in progress, skipping.');
    return cache.data;
  }
  cache.building = true;
  try {
    const { from, to } = getDateRange();
    const raw = await buildRawData(from, to);
    cache.data      = raw;
    cache.fetchedAt = new Date();
    cache.expiresAt = new Date(Date.now() + CACHE_TTL);
    console.log(`[Cache] Ready. Next refresh after ${cache.expiresAt.toISOString()}`);
    return raw;
  } finally {
    cache.building = false;
  }
}

// Kick off first build on startup (non-blocking)
refreshCache().catch(err => console.error('[Cache] Initial build failed:', err.message));

// Auto-refresh on schedule
setInterval(() => {
  refreshCache().catch(err => console.error('[Cache] Refresh error:', err.message));
}, CACHE_TTL);

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheValid: isCacheValid(),
    building: cache.building,
    fetchedAt: cache.fetchedAt,
    expiresAt: cache.expiresAt,
    teamRows: cache.data?.teams?.length || 0,
    engineerRows: cache.data?.engineers?.length || 0,
    meta: cache.data?.meta || null,
  });
});

// Fast single-week test — confirms data + units without the full build
app.get('/api/debug-week', async (req, res) => {
  try {
    const from = req.query.from || `${new Date().getFullYear()}-04-06`;
    const to   = req.query.to   || `${new Date().getFullYear()}-04-12`;
    const report = await fetchReportRange(from, to);
    const resources = Array.isArray(report) ? report : (report.resources || report.data || []);
    res.json({
      range: { from, to },
      resourceCount: resources.length,
      firstThree: resources.slice(0, 3).map(r => ({
        name: r.name,
        job_title: r.job_title,
        booked_min: r.booked,
        availability_min: r.availability,
        booked_hours: r.booked ? +(r.booked / 60).toFixed(1) : 0,
        available_hours: r.availability ? +(r.availability / 60).toFixed(1) : 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/utilisation', async (req, res) => {
  try {
    if (req.query.refresh === '1') await refreshCache();
    if (!cache.data) {
      // First build may still be running
      return res.status(503).json({ error: 'Data is being built. Refresh in ~30 seconds.', building: cache.building });
    }
    res.json(cache.data);
  } catch (err) {
    console.error('[/api/utilisation]', err);
    res.status(500).json({ error: err.message });
  }
});

// Claude AI proxy (only used if the AI panel is enabled in the dashboard)
app.post('/api/claude', async (req, res) => {
  const { messages, system } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const payload = { model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages };
    if (system) payload.system = system;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  console.log(`\n🚀 Dashboard proxy on http://localhost:${PORT}`);
  console.log(`   RG account: ${process.env.RG_ACCOUNT || '(not set)'}`);
  console.log(`   Cache TTL: ${CACHE_TTL / 60000} min\n`);
});
