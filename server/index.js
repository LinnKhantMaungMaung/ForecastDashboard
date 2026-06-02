// server/index.js
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fetch   = require('node-fetch');
const { fetchReportRange } = require('./resourceGuru');
const { buildRawData }     = require('./transformer');

const app  = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '3600000', 10);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

let cache = { data: null, fetchedAt: null, expiresAt: null, building: false };
const isCacheValid = () => cache.data && cache.expiresAt && new Date() < cache.expiresAt;

function getDateRange() {
  const now  = new Date();
  const year = now.getFullYear();
  return { from: `${year}-04-01`, to: `${year}-10-03` };
}

async function refreshCache() {
  if (cache.building) return cache.data;
  cache.building = true;
  try {
    const { from, to } = getDateRange();
    const raw = await buildRawData(from, to);
    cache.data      = raw;
    cache.fetchedAt = new Date();
    cache.expiresAt = new Date(Date.now() + CACHE_TTL);
    console.log(`[Cache] Ready. ${raw.teams.length} team-week rows.`);
    return raw;
  } finally {
    cache.building = false;
  }
}

refreshCache().catch(err => console.error('[Cache] Initial build failed:', err.message));
setInterval(() => refreshCache().catch(err => console.error('[Cache] Refresh error:', err.message)), CACHE_TTL);

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', cacheValid: isCacheValid(), building: cache.building,
    fetchedAt: cache.fetchedAt, expiresAt: cache.expiresAt,
    teamRows: cache.data?.teams?.length || 0,
    engineerRows: cache.data?.engineers?.length || 0,
    resourceTypes: cache.data?.resource_types || [],
    meta: cache.data?.meta || null,
  });
});

app.get('/api/utilisation', async (req, res) => {
  try {
    if (req.query.refresh === '1') await refreshCache();
    if (!cache.data) return res.status(503).json({ error: 'Data building. Retry in ~30s.', building: cache.building });
    res.json(cache.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug-week', async (req, res) => {
  try {
    const from = req.query.from || `${new Date().getFullYear()}-04-06`;
    const to   = req.query.to   || `${new Date().getFullYear()}-04-12`;
    const report = await fetchReportRange(from, to);
    const resources = Array.isArray(report) ? report : (report.resources || report.data || []);
    res.json({
      range: { from, to }, resourceCount: resources.length,
      firstThree: resources.slice(0, 3).map(r => ({
        name: r.name, job_title: r.job_title,
        booked_min: r.booked, availability_min: r.availability,
        waiting_list_min: r.waiting_list,
        booked_hours: r.booked ? +(r.booked / 60).toFixed(1) : 0,
        available_hours: r.availability ? +(r.availability / 60).toFixed(1) : 0,
        tentative_hours: r.waiting_list ? +(r.waiting_list / 60).toFixed(1) : 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claude', async (req, res) => {
  const { messages, system } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const payload = { model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages };
    if (system) payload.system = system;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
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
