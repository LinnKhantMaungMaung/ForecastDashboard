// server/resourceGuru.js
// ─────────────────────────────────────────────────────────────────────────────
// Resource Guru API client
// Uses the v2 reports endpoint called once PER WEEK to build weekly data
// without paginating thousands of raw bookings (which hits rate limits).
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const BASE = 'https://api.resourceguruapp.com/v1';
const TOKEN_URL = 'https://api.resourceguruapp.com/oauth/token';

let _accessToken = null;
let _refreshToken = null;
let _tokenExpiresAt = 0;

// ── Authentication (password grant) ──────────────────────────────────────────
async function authenticate() {
  console.log('[RG] Authenticating...');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username:   process.env.RG_USERNAME,
      password:   process.env.RG_PASSWORD,
      client_id:  process.env.RG_CLIENT_ID,
      client_secret: process.env.RG_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`RG auth failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  _accessToken  = data.access_token;
  _refreshToken = data.refresh_token;
  _tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log('[RG] Authenticated.');
}

async function ensureToken() {
  if (!_accessToken || Date.now() >= _tokenExpiresAt) await authenticate();
}

// ── Small helper: sleep ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Fetch active resources (one call, paginated lightly) ─────────────────────
async function fetchResources() {
  await ensureToken();
  const url = `${BASE}/${process.env.RG_ACCOUNT}/resources`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${_accessToken}` } });
  if (!res.ok) throw new Error(`RG resources ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Fetch the v2 resource report for a SINGLE date range ─────────────────────
// Returns array of resources with booked/available totals for that range only.
async function fetchReportRange(from, to) {
  await ensureToken();
  const url = new URL(`${BASE}/${process.env.RG_ACCOUNT}/reports/resources`);
  url.searchParams.set('start_date', from);
  url.searchParams.set('end_date', to);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${_accessToken}` },
  });

  if (res.status === 429) {
    const retry = parseInt(res.headers.get('Retry-After') || '5', 10);
    console.warn(`[RG] Rate limited — waiting ${retry}s`);
    await sleep(retry * 1000);
    return fetchReportRange(from, to);
  }

  if (!res.ok) throw new Error(`RG report ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Legacy single-shot report (kept for compatibility) ───────────────────────
async function fetchReport(from, to) {
  return fetchReportRange(from, to);
}

module.exports = { authenticate, fetchResources, fetchReport, fetchReportRange, sleep };
