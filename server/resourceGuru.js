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
  let page = 1;
  while (true) {
    const data = await rgGet('/resources', { per_page: 100, page });
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break; // last page
    page++;
    await sleep(200);
  }
  console.log(`[RG] Fetched ${results.length} resources total`);
  return results;
}

// All resource types — tells us which IDs are Contractor, Equipment etc
async function fetchResourceTypes() {
  console.log('[RG] Fetching resource types...');
  return rgGet('/resource_types');
}

// v2 utilisation report for a single week range
// Returns array of resources with booked/availability totals for that period
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

// Bookings for a date range — split into monthly chunks fetched in parallel
// This is much faster than a single sequential paginated fetch for large ranges
async function fetchBookingsForRange(from, to) {
  console.log(`[RG] Fetching bookings ${from} → ${to}...`);

  // Split the range into monthly chunks for parallel fetching
  const chunks = [];
  let cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    const chunkFrom = cur.toISOString().slice(0, 10);
    // End of month (or overall end, whichever is sooner)
    const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const chunkTo  = monthEnd < end ? monthEnd.toISOString().slice(0, 10) : to;
    chunks.push({ from: chunkFrom, to: chunkTo });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }

  console.log(`[RG] Fetching bookings in ${chunks.length} monthly chunks...`);

  // Fetch all chunks in parallel (max 4 at a time to respect rate limits)
  const allResults = [];
  for (let i = 0; i < chunks.length; i += 4) {
    const batch = chunks.slice(i, i + 4);
    const batchResults = await Promise.all(batch.map(chunk => fetchBookingsPage(chunk.from, chunk.to)));
    batchResults.forEach(r => allResults.push(...r));
    if (i + 4 < chunks.length) await sleep(500); // brief pause between batches
  }

  console.log(`[RG] Fetched ${allResults.length} bookings total`);
  return allResults;
}

// Fetch all pages of bookings for a single date chunk
async function fetchBookingsPage(from, to) {
  const results = [];
  let page = 1;
  while (true) {
    const data = await rgGet('/bookings', {
      start_date: from, end_date: to, per_page: 300, page,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 300) break;
    page++;
    await sleep(200);
  }
  return results;
}

// Fetch a single page of bookings (for debugging field names)
async function fetchBookingsSample(from, to) {
  return rgGet('/bookings', { start_date: from, end_date: to, per_page: 3, page: 1 });
}

module.exports = {
  authenticate,
  fetchResources,
  fetchResourceTypes,
  fetchReport,
  fetchReportRange,
  fetchBookingsForRange,
  fetchBookingsSample,
  sleep,
  BASE,
};
