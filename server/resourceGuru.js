// server/resourceGuru.js
// ─────────────────────────────────────────────────────────────────────────────
// Resource Guru API client
// Handles OAuth password-grant auth, token refresh, rate limiting,
// and all data fetching the proxy needs.
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const BASE      = 'https://api.resourceguruapp.com/v1';
const TOKEN_URL = 'https://api.resourceguruapp.com/oauth/token';

let _accessToken   = null;
let _refreshToken  = null;
let _tokenExpiresAt = 0;

// ── Auth ──────────────────────────────────────────────────────────────────────
async function authenticate() {
  console.log('[RG] Authenticating...');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'password',
      username:      process.env.RG_USERNAME,
      password:      process.env.RG_PASSWORD,
      client_id:     process.env.RG_CLIENT_ID,
      client_secret: process.env.RG_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`RG auth failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  _accessToken    = data.access_token;
  _refreshToken   = data.refresh_token;
  _tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log('[RG] Authenticated.');
}

async function ensureToken() {
  if (!_accessToken || Date.now() >= _tokenExpiresAt) await authenticate();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Generic authenticated GET ─────────────────────────────────────────────────
async function rgGet(path, params = {}) {
  await ensureToken();
  const url = new URL(`${BASE}/${process.env.RG_ACCOUNT}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  while (true) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${_accessToken}` },
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('Retry-After') || '5', 10);
      console.warn(`[RG] Rate limited on ${path} — waiting ${retry}s`);
      await sleep(retry * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`RG ${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
}

// ── Specific fetchers ─────────────────────────────────────────────────────────

// All active resources — includes name, job_title, resource_type, groups
async function fetchResources() {
  console.log('[RG] Fetching resources (all pages)...');
  const results = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const data = await rgGet('/resources', { limit, offset });
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    // IMPORTANT: advance by however many we actually got back, not by the
    // requested limit, and only stop on a genuinely EMPTY page. This is the
    // exact same bug already found and fixed for /projects and /clients —
    // "Fetched 50 resources total" was the same suspicious round-number
    // symptom that turned out to mean the API was silently capping the
    // page size below what we requested (per_page=100 was being ignored),
    // so anything past position 50 (including 3 Placeholder resources
    // confirmed to exist in this account) was silently never fetched.
    offset += data.length;
    await sleep(150);
  }
  console.log(`[RG] Fetched ${results.length} resources total`);
  return results;
}

// All resource types — tells us which IDs are Contractor, Equipment etc
async function fetchResourceTypes() {
  console.log('[RG] Fetching resource types...');
  return rgGet('/resource_types');
}

// All Projects — used to identify bookings under specifically-excluded
// projects (e.g. on-call/rota bookings that shouldn't count toward
// utilisation) by matching on project name.
async function fetchProjectsRaw() {
  console.log('[RG] Fetching projects (all pages)...');
  const results = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const data = await rgGet('/projects', { limit, offset });
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    // IMPORTANT: advance by however many we actually got back, not by the
    // requested limit, and only stop on a genuinely EMPTY page. If the API
    // silently caps the page size below what we requested, stopping on
    // "data.length < limit" ends pagination early and silently drops
    // everything past that point — this is exactly what happened before:
    // 50 projects came back and we assumed that was everything, but the
    // account has more, including several archived/inactive ones that
    // never appeared. One extra request at the very end is a small cost
    // for guaranteeing nothing gets missed.
    offset += data.length;
    await sleep(150);
  }
  console.log(`[RG] Fetched ${results.length} projects total`);
  return results;
}

// All Clients — some bookings aren't tied to a Project at all, only a
// Client (e.g. standing rota bookings), so this is needed to resolve
// client-based exclusions too.
async function fetchClientsRaw() {
  console.log('[RG] Fetching clients (all pages)...');
  const results = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const data = await rgGet('/clients', { limit, offset });
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    offset += data.length; // see note in fetchProjectsRaw() above
    await sleep(150);
  }
  console.log(`[RG] Fetched ${results.length} clients total`);
  return results;
}

// ── Shared long-lived cache for Projects/Clients ────────────────────────────
// Unlike weekly booking/report data, the account's project and client lists
// barely change day to day. buildRawData() can run once per distinct date
// range requested (see the dashboard's per-range cache), and without this,
// each of those would trigger a full projects+clients refetch even though
// the underlying list is identical every time. Cached here independently of
// that per-range cache, with its own longer TTL.
const LOOKUP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let _projectsCache = { data: null, expiresAt: 0 };
let _clientsCache  = { data: null, expiresAt: 0 };

async function fetchProjects(forceRefresh = false) {
  if (!forceRefresh && _projectsCache.data && Date.now() < _projectsCache.expiresAt) {
    console.log(`[RG] Using cached projects list (${_projectsCache.data.length} projects)`);
    return _projectsCache.data;
  }
  const data = await fetchProjectsRaw();
  _projectsCache = { data, expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS };
  return data;
}

async function fetchClients(forceRefresh = false) {
  if (!forceRefresh && _clientsCache.data && Date.now() < _clientsCache.expiresAt) {
    console.log(`[RG] Using cached clients list (${_clientsCache.data.length} clients)`);
    return _clientsCache.data;
  }
  const data = await fetchClientsRaw();
  _clientsCache = { data, expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS };
  return data;
}

// Time Off / Downtime events (holidays, sick leave, etc.) — a SEPARATE
// resource from Bookings entirely, confirmed via RG's UI ("Time Off" popup,
// distinct black-bar styling from colored project Bookings). Each event has
// resource_ids (array — one event can cover several people), from/to dates,
// start_time/end_time (minutes from midnight), and a state
// ("Approved"/"Pending"/etc — only Approved should count as real absence).
async function fetchDowntimes(from, to) {
  console.log(`[RG] Fetching downtimes (Time Off): ${from} → ${to}...`);
  const results = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const data = await rgGet('/downtimes', { from, to, limit, offset });
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    offset += data.length;
    await sleep(150);
  }
  console.log(`[RG] Fetched ${results.length} downtime (Time Off) events total`);
  return results;
}

// Downtime/Time Off event TYPES (e.g. "Holiday (personal)", "Compassionate
// leave") — maps downtime_type_id to a readable name.
async function fetchDowntimeTypes() {
  console.log('[RG] Fetching downtime types...');
  return rgGet('/downtime_types');
}

// v2 utilisation report for a single week range
// Returns array of resources with booked/availability totals for that period.
// IMPORTANT: "booked" here includes BOTH confirmed AND tentative bookings —
// Resource Guru's Report endpoint does not separate them. "waiting_list" is a
// totally different concept (overflow bookings that don't fit within
// availability due to a clash), not "tentative". Use fetchBookings() below
// for a real confirmed-vs-tentative split.
async function fetchReportRange(from, to) {
  await ensureToken();
  const url = new URL(`${BASE}/${process.env.RG_ACCOUNT}/reports/resources`);
  url.searchParams.set('start_date', from);
  url.searchParams.set('end_date',   to);
  console.log(`[RG] Fetching report: ${from} → ${to}  (${url})`);
  while (true) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${_accessToken}` },
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('Retry-After') || '5', 10);
      console.warn(`[RG] Rate limited on report — waiting ${retry}s`);
      await sleep(retry * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`RG report ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

// Alias kept for backward compat
async function fetchReport(from, to) {
  return fetchReportRange(from, to);
}

// Raw Bookings for a date range, across ALL resources, paginated.
// Each Booking has a top-level "tentative" boolean and a "durations" array
// (one entry per calendar day, each with its own "date", "duration" in
// minutes, and a "waiting" boolean for waiting-list days). This is the ONLY
// way to distinguish real tentative bookings from confirmed ones — the
// Report endpoint lumps them together into "booked".
async function fetchBookings(from, to) {
  await ensureToken();
  console.log(`[RG] Fetching bookings: ${from} → ${to}...`);
  const results = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const url = new URL(`${BASE}/${process.env.RG_ACCOUNT}/bookings`);
    url.searchParams.set('start_date', from);
    url.searchParams.set('end_date',   to);
    url.searchParams.set('limit',  limit);
    url.searchParams.set('offset', offset);

    let page;
    while (true) {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${_accessToken}` },
      });
      if (res.status === 429) {
        const retry = parseInt(res.headers.get('Retry-After') || '5', 10);
        console.warn(`[RG] Rate limited on bookings — waiting ${retry}s`);
        await sleep(retry * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`RG bookings ${res.status}: ${await res.text()}`);
      page = await res.json();
      break;
    }
    if (!Array.isArray(page) || page.length === 0) break;
    results.push(...page);
    if (page.length < limit) break; // last page
    offset += limit;
    await sleep(150);
  }
  console.log(`[RG] Fetched ${results.length} bookings total`);
  return results;
}

module.exports = {
  authenticate,
  fetchResources,
  fetchResourceTypes,
  fetchProjects,
  fetchClients,
  fetchDowntimes,
  fetchDowntimeTypes,
  fetchReport,
  fetchReportRange,
  fetchBookings,
  sleep,
  BASE,
};
