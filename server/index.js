// server/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Express proxy server
// Routes:
//   GET  /api/utilisation   → Returns RAW data (teams + engineers) for dashboard
//   GET  /api/health        → Health + cache status
//   POST /api/claude        → Forwards requests to Claude for AI insights
//   GET  /                  → Serves the dashboard HTML
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fetch   = require('node-fetch');

const { fetchResources, fetchBookings, fetchReport } = require('./resourceGuru');
const { transformReport, transformFromBookings }     = require('./transformer');

const app  = express();
const PORT = process.env.PORT || 10000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '900000', 10); // 15 min

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── In-memory cache ───────────────────────────────────────────────────────────
let cache = {
  data:        null,   // the RAW object
  fetchedAt:   null,   // Date
  expiresAt:   null,   // Date
};

function isCacheValid() {
  return cache.data && cache.expiresAt && new Date() < cache.expiresAt;
}

// ── Core data fetcher ─────────────────────────────────────────────────────────
async function refreshCache() {
  console.log('[Cache] Refreshing data from Resource Guru...');

  // Date range: today's year start → 12 months forward
  const now   = new Date();
  const from  = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);  // Jan 1 this year
  const to    = new Date(now.getFullYear() + 1, 0, 1).toISOString().slice(0, 10); // Jan 1 next year

  let raw;
  try {
    // Try the reports endpoint first (most accurate)
    const reportData = await fetchReport(from, to);
    raw = transformReport(reportData);
    console.log(`[Cache] Transformed report: ${raw.teams.length} team-week rows, ${raw.engineers.length} engineer-week rows`);
  } catch (err) {
    console.warn('[Cache] Reports endpoint failed, falling back to bookings:', err.message);
    // Fallback: fetch resources + bookings and transform manually
    const [resources, bookings] = await Promise.all([
      fetchResources(),
      fetchBookings(from, to),
    ]);
    raw = transformFromBookings(resources, bookings);
    console.log(`[Cache] Transformed bookings: ${raw.teams.length} team-week rows`);
  }

  cache.data      = raw;
  cache.fetchedAt = new Date();
  cache.expiresAt = new Date(Date.now() + CACHE_TTL);
  console.log(`[Cache] Ready. Next refresh at ${cache.expiresAt.toISOString()}`);
  return raw;
}

// Kick off first fetch on startup (non-blocking)
refreshCache().catch(err => {
  console.error('[Cache] Initial fetch failed:', err.message);
  console.error('        Check your .env credentials and try again.');
});

// Auto-refresh on schedule
setInterval(() => {
  refreshCache().catch(err => console.error('[Cache] Refresh error:', err.message));
}, CACHE_TTL);

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/health
 * Returns server status and cache metadata
 */
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    cacheValid: isCacheValid(),
    fetchedAt:  cache.fetchedAt,
    expiresAt:  cache.expiresAt,
    meta:       cache.data?.meta || null,
  });
});

/**
 * GET /api/utilisation
 * Returns the RAW object exactly matching the dashboard's expected shape.
 * Query params:
 *   ?refresh=1   → force a cache refresh first
 */
app.get('/api/utilisation', async (req, res) => {
  try {
    if (req.query.refresh === '1' || !isCacheValid()) {
      await refreshCache();
    }

    if (!cache.data) {
      return res.status(503).json({ error: 'Data not yet available. Please wait a moment and retry.' });
    }

    res.json(cache.data);
  } catch (err) {
    console.error('[/api/utilisation] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/debug-resource', async (req, res) => {
  const { fetchResources } = require('./resourceGuru');
  const resources = await fetchResources();
  res.json(resources[0]); // show first resource in full
});
// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Dashboard proxy running at http://localhost:${PORT}`);
  console.log(`   Resource Guru account: ${process.env.RG_ACCOUNT || '(not set)'}`);
  console.log(`   Cache TTL: ${CACHE_TTL / 60000} minutes`);
  console.log(`   Claude AI: ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ missing ANTHROPIC_API_KEY'}\n`);
});
