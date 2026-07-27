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

// ── In-memory cache ───────────────────────────────────────────────────────────
let cache = { data: null, fetchedAt: null, expiresAt: null, building: false };
const isCacheValid = () => cache.data && cache.expiresAt && new Date() < cache.expiresAt;


// Custom date range — set by API call, defaults to current year Apr-Oct
let customDateRange = null;

function getDateRange() {
  if (customDateRange) return customDateRange;
  const year = new Date().getFullYear();
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
    console.log(`[Cache] Utilisation ready — ${raw.teams.length} team-week rows, ${raw.engineers.length} engineer-week rows`);

    return raw;
  } finally {
    cache.building = false;
  }
}

// Start initial cache build on server startup
refreshCache().catch(err => {
  console.error('[Cache] Initial build failed:', err.message);
  console.error('        Check your .env credentials.');
});

// Auto-refresh on schedule
setInterval(() => {
  refreshCache().catch(err => console.error('[Cache] Refresh error:', err.message));
}, CACHE_TTL);

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check + cache metadata
app.get('/api/health', (req, res) => {
  res.json({
    status:       'ok',
    cacheValid:   isCacheValid(),
    building:     cache.building,
    fetchedAt:    cache.fetchedAt,
    expiresAt:    cache.expiresAt,
    teamRows:     cache.data?.teams?.length     || 0,
    engineerRows: cache.data?.engineers?.length || 0,
    resourceTypes: cache.data?.resource_types   || [],
    meta:         cache.data?.meta              || null,
  });
});

// Main data endpoint — returns full RAW object for the dashboard
app.get('/api/utilisation', async (req, res) => {
  try {
    const customFrom = req.query.from;
    const customTo   = req.query.to;
    // Custom date range: set the range and do a full cache rebuild
    if (req.query.refresh === '1' && customFrom && customTo) {
      console.log(`[Cache] Setting custom range: ${customFrom} → ${customTo}`);
      customDateRange = { from: customFrom, to: customTo };
      await refreshCache();
    } else if (req.query.refresh === '1') {
      await refreshCache();
    }
    if (!cache.data) {
      return res.status(503).json({
        error: 'Data is still being built. Retry in ~30 seconds.',
        building: cache.building,
      });
    }
    res.json(cache.data);
  } catch (err) {
    console.error('[/api/utilisation]', err);
    res.status(500).json({ error: err.message });
  }
});

// Reset to default date range
app.get('/api/reset-range', async (req, res) => {
  customDateRange = null;
  await refreshCache();
  res.json({ ok: true, range: getDateRange(), weeks: cache.data?.meta?.weeks });
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

  const availableTeams = ['Design','HELIX','Electrical Installation','Control Panels - Notts',
    'PLC','PLC - Amazon','Robotics','Projects','Service','Director','Unassigned'];

  const teamList = availableTeams.join(', ');
  const stringList = rawStrings.join('\n');
  const prompt = 'You are parsing a Microsoft Project file for MotionTech, an automation systems integrator.\n\n' +
    'Strings extracted from the binary:\n' + stringList + '\n\n' +
    'Available teams: ' + teamList + '\n\n' +
    'Return ONLY a JSON array of tasks/phases. No explanation, no markdown:\n' +
    '[{"name":"task name","team":"team from list","dur_weeks":2,"start_offset_weeks":0,"is_summary":false}]\n\n' +
    'Rules:\n' +
    '- Section headers (Design: Electrical, Build:, Commissioning: etc) = is_summary true\n' +
    '- Match team from context: Design Engineer/Electrical -> Design, Control Systems/PLC tasks -> PLC, Commissioning -> PLC, Install -> Electrical Installation, Panel Build -> Control Panels - Notts, Software/HELIX -> HELIX, Project Manager -> Projects\n' +
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
