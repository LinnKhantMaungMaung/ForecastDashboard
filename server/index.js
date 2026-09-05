// server/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Express proxy server
//
// Routes:
//   GET  /                        → serves the dashboard HTML
//   GET  /api/health              → cache status + metadata
//   GET  /api/utilisation         → full RAW data object for the dashboard
//   GET  /api/debug-raw           → raw Resource Guru API response (1 week, all fields)
//   GET  /api/debug-resources     → raw /resources response (shows groups, resource_type)
//   GET  /api/debug-week          → processed single week (hours converted)
//   POST /api/claude              → proxies to Anthropic (keeps API key server-side)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { execFile, spawn } = require('child_process');
const fetch   = require('node-fetch');

const { fetchReportRange, fetchResources, fetchResourceTypes, BASE } = require('./resourceGuru');
const { buildRawData } = require('./transformer');

const app      = express();
const PORT     = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '3600000', 10); // default 1 hour

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Per-date-range cache (Fix 3: no shared global state between users) ────────
// Every distinct {from, to} range gets its own cache slot, keyed by "from_to".
// Two users requesting different ranges never see or overwrite each other's data.
// Users requesting the identical range legitimately share the cached result
// (it's the same data either way — this is not "their" personal state).
// No sessions, no cookies, no authentication involved.
// IMPORTANT: this was originally 24 hours, but that meant any change made
// directly in Resource Guru (a new booking, a new holiday, etc.) was
// invisible on the dashboard for up to a full day — nothing in the normal
// flow (page refresh, or the periodic background poll in index.html) ever
// passes refresh=1, so a long TTL just kept serving stale cached data
// indefinitely until it happened to expire. 15 minutes balances staying
// reasonably close to live against not hammering the Resource Guru API on
// every single page load/poll.
const RANGE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const rangeCaches = new Map(); // key "from_to" → { data, fetchedAt, expiresAt, building, buildPromise }

const DEFAULT_RANGE = (() => {
  const year = new Date().getFullYear();
  return { from: `${year}-04-01`, to: `${year}-10-03` };
})();

function rangeKey(from, to) {
  return `${from}_${to}`;
}

// Pruning happens whenever the cache is accessed or updated, per spec.
function pruneExpiredCaches() {
  const now = Date.now();
  for (const [key, entry] of rangeCaches) {
    if (entry.expiresAt && entry.expiresAt.getTime() < now && !entry.building) {
      rangeCaches.delete(key);
    }
  }
}

function isEntryValid(entry) {
  return !!(entry && entry.data && entry.expiresAt && Date.now() < entry.expiresAt.getTime());
}

// Fetch (or build) the data for a specific {from, to} range.
// forceRefresh bypasses a still-valid cache entry and rebuilds.
// NOTE: previously tried scaling this TTL up for long ranges (12 hours
// instead of 15 minutes), reasoning that a successfully-built long range
// shouldn't need frequent rebuilding. Reverted — if the range's build is
// EVER incomplete for a persistent (not transient) reason, a long TTL
// locks in that broken result for 12 hours instead of 15 minutes, which is
// strictly worse. Keeping a flat, short TTL everywhere until the actual
// root cause of incomplete long-range builds is confirmed and fixed.
async function getDataForRange(from, to, forceRefresh = false) {
  pruneExpiredCaches();
  const key = rangeKey(from, to);
  let entry = rangeCaches.get(key);

  if (!forceRefresh && isEntryValid(entry)) {
    return entry.data;
  }

  if (entry && entry.building) {
    // Someone else already triggered a build for this exact range —
    // wait for it instead of racing a second build or returning stale data.
    return entry.buildPromise;
  }

  entry = entry || {};
  entry.building = true;
  rangeCaches.set(key, entry);

  entry.buildPromise = (async () => {
    try {
      const raw = await buildRawData(from, to);
      entry.data      = raw;
      entry.fetchedAt = new Date();
      entry.expiresAt = new Date(Date.now() + RANGE_CACHE_TTL_MS);
      console.log(`[Cache] Range ${key} ready — ${raw.teams.length} team-week rows, ${raw.engineers.length} engineer-week rows`);
      return raw;
    } finally {
      entry.building = false;
    }
  })();

  return entry.buildPromise;
}

function getCacheStatus() {
  pruneExpiredCaches();
  const defaultKey = rangeKey(DEFAULT_RANGE.from, DEFAULT_RANGE.to);
  return { key: defaultKey, entry: rangeCaches.get(defaultKey) || null, totalRanges: rangeCaches.size };
}

// Start initial cache build (default range) on server startup
getDataForRange(DEFAULT_RANGE.from, DEFAULT_RANGE.to).catch(err => {
  console.error('[Cache] Initial build failed:', err.message);
  console.error('        Check your .env credentials.');
});

// Auto-refresh the default range on schedule (keeps the common case warm)
setInterval(() => {
  getDataForRange(DEFAULT_RANGE.from, DEFAULT_RANGE.to, true)
    .catch(err => console.error('[Cache] Refresh error:', err.message));
}, RANGE_CACHE_TTL_MS);

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check + cache metadata (reports the default range's slot)
app.get('/api/health', (req, res) => {
  const { entry, totalRanges } = getCacheStatus();
  res.json({
    status:        'ok',
    cacheValid:    isEntryValid(entry),
    building:      !!entry?.building,
    fetchedAt:     entry?.fetchedAt  || null,
    expiresAt:     entry?.expiresAt  || null,
    teamRows:      entry?.data?.teams?.length     || 0,
    engineerRows:  entry?.data?.engineers?.length || 0,
    resourceTypes: entry?.data?.resource_types    || [],
    meta:          entry?.data?.meta              || null,
    activeRangeCaches: totalRanges,
  });
});

// Main data endpoint — returns full RAW object for the dashboard.
// Each distinct {from, to} pair is cached independently (see rangeCaches above),
// so concurrent users on different ranges never overwrite each other's data.
app.get('/api/utilisation', async (req, res) => {
  try {
    const customFrom = req.query.from;
    const customTo   = req.query.to;
    const forceRefresh = req.query.refresh === '1';
    const { from, to } = (customFrom && customTo)
      ? { from: customFrom, to: customTo }
      : DEFAULT_RANGE;

    if (forceRefresh) {
      console.log(`[Cache] Refresh requested for range: ${from} → ${to}`);
    }

    const data = await getDataForRange(from, to, forceRefresh);
    res.json(data);
  } catch (err) {
    console.error('[/api/utilisation]', err);
    res.status(500).json({ error: err.message });
  }
});

// Reset to default date range — with per-range caching there's nothing global
// to clear; this just ensures the default range's data is ready and returns it.
app.get('/api/reset-range', async (req, res) => {
  const data = await getDataForRange(DEFAULT_RANGE.from, DEFAULT_RANGE.to);
  res.json({ ok: true, range: DEFAULT_RANGE, weeks: data?.meta?.weeks });
});


// ── Debug routes ──────────────────────────────────────────────────────────────

// Shows EVERY field returned by RG reports endpoint for one week — raw, unprocessed
// Visit: /api/debug-raw  or  /api/debug-raw?from=2026-06-01&to=2026-06-07
app.get('/api/debug-raw', async (req, res) => {
  try {
    const from = req.query.from || `${new Date().getFullYear()}-04-06`;
    const to   = req.query.to   || `${new Date().getFullYear()}-04-12`;

    // This is the exact API call the transformer makes for each week:
    // GET https://api.resourceguruapp.com/v1/{account}/reports/resources?start_date=X&end_date=Y
    const report    = await fetchReportRange(from, to);
    const resources = Array.isArray(report) ? report : (report.resources || report.data || []);

    res.json({
      info: 'Raw response from Resource Guru reports/resources endpoint — no processing applied',
      endpoint: `${BASE}/${process.env.RG_ACCOUNT}/reports/resources`,
      dateRange: { from, to },
      resourceCount: resources.length,
      // Return ALL resources with ALL their fields exactly as RG sends them
      rawResources: resources,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shows the raw /resources endpoint — this is where groups/departments live
// Visit: /api/debug-resources
app.get('/api/debug-resources', async (req, res) => {
  try {
    // This is the call: GET https://api.resourceguruapp.com/v1/{account}/resources
    const [resources, resourceTypes] = await Promise.all([
      fetchResources(),
      fetchResourceTypes(),
    ]);

    res.json({
      info: 'Raw response from Resource Guru /resources and /resource_types endpoints',
      resourcesEndpoint:     `${BASE}/${process.env.RG_ACCOUNT}/resources`,
      resourceTypesEndpoint: `${BASE}/${process.env.RG_ACCOUNT}/resource_types`,
      resourceTypesList: resourceTypes,
      resourceCount: Array.isArray(resources) ? resources.length : 0,
      // Show first 5 resources in full so you can see what fields are available
      sampleResources: Array.isArray(resources) ? resources.slice(0, 5) : resources,
      // Show group summary for all resources
      groupSummary: Array.isArray(resources) ? resources.map(r => ({
        name:          r.name,
        job_title:     r.job_title,
        resource_type: r.resource_type,
        groups:        r.groups,
      })) : [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shows a single week processed through the transformer logic (hours converted)
app.get('/api/debug-week', async (req, res) => {
  try {
    const from = req.query.from || `${new Date().getFullYear()}-04-06`;
    const to   = req.query.to   || `${new Date().getFullYear()}-04-12`;
    const report    = await fetchReportRange(from, to);
    const resources = Array.isArray(report) ? report : (report.resources || report.data || []);
    res.json({
      range: { from, to },
      resourceCount: resources.length,
      processedResources: resources.map(r => ({
        name:             r.name,
        job_title:        r.job_title,
        available_hours:  r.availability  ? +(r.availability  / 60).toFixed(1) : 0,
        utilized_hours:   r.booked        ? +(r.booked        / 60).toFixed(1) : 0,
        tentative_hours:  r.waiting_list  ? +(r.waiting_list  / 60).toFixed(1) : 0,
        utilization_pct:  r.utilization   ? +(r.utilization   * 100).toFixed(1) : 0,
        // Raw minute values for reference
        _raw_availability_min: r.availability,
        _raw_booked_min:       r.booked,
        _raw_waiting_list_min: r.waiting_list,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Claude AI proxy ───────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  const { messages, system } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const payload = { model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages };
    if (system) payload.system = system;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
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

// Serve dashboard for all other routes
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
// ── MPP file parser + Claude AI ──────────────────────────────────────────────
// Receives raw MPP binary, extracts strings via Python, then asks Claude
// to parse task names, dates, durations and resource → team mapping
app.post('/api/parse-mpp-ai', require('express').raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');
  const { execFile } = require('child_process');

  if (!req.body || req.body.length === 0) return res.status(400).json({ error: 'No file data' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const tmpFile    = path.join(os.tmpdir(), 'mppai_' + Date.now() + '.mpp');
  const scriptPath = path.join(__dirname, 'mpp_extract.py');

  try {
    fs.writeFileSync(tmpFile, req.body);
  } catch(e) {
    return res.status(500).json({ error: 'Could not write temp file: ' + e.message });
  }

  // Step 1: extract raw strings from binary MPP
  let extracted;
  try {
    extracted = await new Promise((resolve, reject) => {
      execFile('python3', [scriptPath, tmpFile], { timeout: 30000 }, (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (err) return reject(new Error('Extractor failed: ' + err.message));
        try { resolve(JSON.parse(stdout)); }
        catch(e) { reject(new Error('Bad extractor output: ' + stdout.slice(0,100))); }
      });
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }

  // If embedded XML found — return directly, no AI needed
  if (extracted.tasks && extracted.tasks.length > 0) {
    return res.json({ source: 'xml', tasks: extracted.tasks });
  }

  // Step 2: send raw strings to Claude for intelligent parsing
  const rawStrings = (extracted.raw_strings || []).slice(0, 120);
  if (rawStrings.length === 0) return res.status(422).json({ error: 'No task data found in MPP file' });

  // Pulled dynamically from whatever's currently cached for the default
  // range, instead of a hardcoded list — a hardcoded list goes stale the
  // moment departments change in RG (e.g. HELIX being split into
  // "HELIX - Product" / "HELIX - Project"), silently offering Claude
  // department names that may not even exist anymore.
  const defaultCacheKey = rangeKey(DEFAULT_RANGE.from, DEFAULT_RANGE.to);
  const cachedTeams = rangeCaches.get(defaultCacheKey)?.data?.teams;
  const availableTeams = Array.isArray(cachedTeams) && cachedTeams.length
    ? [...new Set(cachedTeams.map(t => t.team))].sort()
    : ['Unassigned']; // safe minimal fallback if cache isn't warm yet — avoids offering stale hardcoded names

  const teamList = availableTeams.join(', ');
  const stringList = rawStrings.join('\n');
  const prompt = 'You are parsing a Microsoft Project file for MotionTech, an automation systems integrator.\n\n' +
    'Strings extracted from the binary:\n' + stringList + '\n\n' +
    'Available teams: ' + teamList + '\n\n' +
    'Return ONLY a JSON array of tasks/phases. No explanation, no markdown:\n' +
    '[{"name":"task name","team":"team from list","dur_weeks":2,"start_offset_weeks":0,"is_summary":false}]\n\n' +
    'Rules:\n' +
    '- Section headers (Design: Electrical, Build:, Commissioning: etc) = is_summary true\n' +
    '- Match team from context using the "Available teams" list above (e.g. a task mentioning Design Engineer/Electrical work maps to whichever available team represents Design; Commissioning/Control Systems work maps to whichever represents PLC; Install work maps to whichever represents Electrical Installation; Panel Build work maps to whichever represents panel/control-panel work; Software work maps to whichever available team represents that specialism). Use the exact team name as it appears in the list — do not invent or assume a team name that isn\'t in it.\n' +
    '- dur_weeks: estimate from name (14 days=3w, 5 days=1w, 4 wks=4w, default 2)\n' +
    '- start_offset_weeks: cumulative sequential offset from 0\n' +
    '- Skip: standalone resource name strings, payment terms, UI strings like Gantt/Timeline';

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!aiResp.ok) {
      const err = await aiResp.text();
      return res.status(500).json({ error: 'Claude API error: ' + err.slice(0, 200) });
    }

    const aiData = await aiResp.json();
    const raw    = (aiData.content?.[0]?.text || '').replace(/```json|```/g, '').trim();

    let tasks;
    try { tasks = JSON.parse(raw); }
    catch(e) { return res.status(500).json({ error: 'Claude returned unparseable JSON', raw: raw.slice(0,200) }); }

    res.json({ source: 'ai', tasks, model: 'claude-haiku-4-5-20251001' });

  } catch(e) {
    res.status(500).json({ error: 'Claude call failed: ' + e.message });
  }
});

// ── MPP file parser ──────────────────────────────────────────────────────────
app.post('/api/parse-mpp', require('express').raw({ type: 'application/octet-stream', limit: '50mb' }), (req, res) => {
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');
  const { execFile } = require('child_process');

  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: 'No file data received' });
  }

  const tmpFile    = path.join(os.tmpdir(), 'upload_' + Date.now() + '.mpp');
  const scriptPath = path.join(__dirname, 'mpp_extract.py');

  if (!fs.existsSync(scriptPath)) {
    return res.status(500).json({ error: 'mpp_extract.py not found. Please add it to server/ directory.' });
  }

  try {
    fs.writeFileSync(tmpFile, req.body);
  } catch(err) {
    return res.status(500).json({ error: 'Could not write temp file: ' + err.message });
  }

  console.log('[MPP] Parsing ' + req.body.length + ' bytes');

  execFile('python3', [scriptPath, tmpFile], { timeout: 30000 }, (err, stdout, stderr) => {
    // Always clean up temp file
    try { fs.unlinkSync(tmpFile); } catch {}
    if (stderr) console.log('[MPP stderr]', stderr.slice(0, 300));
    if (err) {
      return res.status(500).json({ error: 'Extractor failed: ' + err.message });
    }
    try {
      res.json(JSON.parse(stdout));
    } catch(e) {
      res.status(500).json({ error: 'Invalid JSON from extractor: ' + stdout.slice(0, 100) });
    }
  });
});
app.get('/api/debug-env', (req, res) => {
  const { execFile } = require('child_process');
  execFile('sh', ['-c', 'which python3; python3 -V; which java; java -version 2>&1; python3 -c "import jpype, olefile, mpxj; print(\'py deps OK\')"'],
    { timeout: 15000 },
    (err, stdout, stderr) => res.type('text').send((stdout || '') + '\n---\n' + (stderr || '') + '\n---\nerr: ' + (err ? err.message : 'none'))
  );
});
app.listen(PORT, () => {
  console.log(`\n🚀 Dashboard proxy running at http://localhost:${PORT}`);
  console.log(`   RG account : ${process.env.RG_ACCOUNT || '(not set — check .env)'}`);
  console.log(`   Cache TTL  : ${CACHE_TTL / 60000} minutes`);
  console.log(`   Claude AI  : ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ missing ANTHROPIC_API_KEY'}`);
  console.log(`\n   Debug endpoints:`);
  console.log(`   /api/debug-raw        — raw RG report data (all fields)`);
  console.log(`   /api/debug-resources  — raw /resources + groups/departments`);
  console.log(`   /api/debug-week       — processed week (hours converted)\n`);
});
