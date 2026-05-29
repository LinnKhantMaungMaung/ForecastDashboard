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
<<<<<<< HEAD
const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '3600000', 10); // default 1 hour
=======
const PORT = process.env.PORT || 10000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '900000', 10); // 15 min
>>>>>>> 8e605bceaa7667cfe7af49d33740550954ac7e13

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

<<<<<<< HEAD
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
=======
/**
 * POST /api/claude
 * Proxies a request to the Anthropic Claude API.
 * The frontend sends: { messages: [...], system?: "..." }
 * We add the model + API key server-side (key never reaches the browser).
 *
 * Body shape:
 * {
 *   system:   string (optional),
 *   messages: [{ role: "user"|"assistant", content: string }]
 * }
 */
app.get('/api/debug', async (req, res) => {
  try {
    const { fetchReport } = require('./resourceGuru');
    const data = await fetchReport('2026-01-01', '2026-12-31');
    res.json(data);
>>>>>>> 8e605bceaa7667cfe7af49d33740550954ac7e13
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
<<<<<<< HEAD

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

=======
app.get('/api/debug-resource', async (req, res) => {
  const { fetchResources } = require('./resourceGuru');
  const resources = await fetchResources();
  res.json(resources[0]); // show first resource in full
});
app.get('/api/debug-report', async (req, res) => {
  const { fetchReport } = require('./resourceGuru');
  const data = await fetchReport('2026-01-01', '2026-12-31');
  // Show just the first resource
  const first = Array.isArray(data) ? data[0] : (data.resources || data.data || [])[0];
  res.json(first);
});
app.get('/api/debug-bookings', async (req, res) => {
  const { fetchBookings } = require('./resourceGuru');
  const bookings = await fetchBookings('2026-04-01', '2026-04-30');
  res.json({ count: bookings.length, first: bookings[0], second: bookings[1] });
});
// ── Start ─────────────────────────────────────────────────────────────────────
>>>>>>> 8e605bceaa7667cfe7af49d33740550954ac7e13
app.listen(PORT, () => {
  console.log(`\n🚀 Dashboard proxy on http://localhost:${PORT}`);
  console.log(`   RG account: ${process.env.RG_ACCOUNT || '(not set)'}`);
  console.log(`   Cache TTL: ${CACHE_TTL / 60000} min\n`);
});
