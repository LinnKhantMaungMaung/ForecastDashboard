// server/resourceGuru.js
const fetch = require('node-fetch');
const BASE = 'https://api.resourceguruapp.com/v1';
const TOKEN_URL = 'https://api.resourceguruapp.com/oauth/token';

let _accessToken = null;
let _refreshToken = null;
let _tokenExpiresAt = 0;

async function authenticate() {
  console.log('[RG] Authenticating...');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username: process.env.RG_USERNAME,
      password: process.env.RG_PASSWORD,
      client_id: process.env.RG_CLIENT_ID,
      client_secret: process.env.RG_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`RG auth failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  _accessToken = data.access_token;
  _refreshToken = data.refresh_token;
  _tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log('[RG] Authenticated.');
}

async function ensureToken() {
  if (!_accessToken || Date.now() >= _tokenExpiresAt) await authenticate();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Generic GET — returns parsed JSON
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
      console.warn(`[RG] Rate limited — waiting ${retry}s`);
      await sleep(retry * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`RG ${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
}

// Fetch all active resources including resource_type details
async function fetchResources() {
  console.log('[RG] Fetching resources...');
  return rgGet('/resources');
}

// Fetch all resource types (tells us which are Person, Contractor, Equipment etc)
async function fetchResourceTypes() {
  console.log('[RG] Fetching resource types...');
  return rgGet('/resource_types');
}

// Fetch the v2 report for a single date range
async function fetchReportRange(from, to) {
  await ensureToken();
  const url = new URL(`${BASE}/${process.env.RG_ACCOUNT}/reports/resources`);
  url.searchParams.set('start_date', from);
  url.searchParams.set('end_date', to);
  while (true) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${_accessToken}` },
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('Retry-After') || '5', 10);
      console.warn(`[RG] Rate limited — waiting ${retry}s`);
      await sleep(retry * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`RG report ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

// Fetch bookings for a date range — used for tentative flag detection
// Uses a small page size to avoid rate limit hammering
async function fetchBookingsForRange(from, to) {
  console.log(`[RG] Fetching bookings for tentative data ${from} → ${to}...`);
  const results = [];
  let page = 1;
  while (true) {
    const data = await rgGet('/bookings', {
      start_date: from, end_date: to, per_page: 100, page,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
    await sleep(300); // stay well under rate limit
  }
  return results;
}

async function fetchReport(from, to) {
  return fetchReportRange(from, to);
}

module.exports = {
  authenticate, fetchResources, fetchResourceTypes,
  fetchReport, fetchReportRange, fetchBookingsForRange, sleep,
};
