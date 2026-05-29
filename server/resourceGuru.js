// server/resourceGuru.js
// ─────────────────────────────────────────────────────────────────────────────
// Resource Guru API client
// Handles OAuth password-grant authentication, token refresh, and fetching
// the three data sets the dashboard needs: resources, bookings, and reports.
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const BASE = 'https://api.resourceguruapp.com/v1/me';
const TOKEN_URL = 'https://api.resourceguruapp.com/oauth/token';

// ── Token state (in-memory; fine for a single-process proxy) ──────────────────
let _accessToken = null;
let _refreshToken = null;
let _tokenExpiresAt = 0;   // epoch ms

// ── 1. Authenticate with password grant ──────────────────────────────────────
async function authenticate() {
  console.log('[RG] Authenticating with password grant...');
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RG auth failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  _accessToken  = data.access_token;
  _refreshToken = data.refresh_token;
  // expires_in is in seconds; subtract a 60-second buffer
  _tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log('[RG] Authenticated. Token expires in', Math.round(data.expires_in / 60), 'minutes');
}

// ── 2. Refresh token when close to expiry ────────────────────────────────────
async function refreshToken() {
  console.log('[RG] Refreshing token...');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'refresh_token',
      refresh_token: _refreshToken,
      client_id:     process.env.RG_CLIENT_ID,
      client_secret: process.env.RG_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    // Refresh failed — fall back to full re-auth
    console.warn('[RG] Refresh failed, re-authenticating...');
    return authenticate();
  }

  const data = await res.json();
  _accessToken  = data.access_token;
  _refreshToken = data.refresh_token || _refreshToken;
  _tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log('[RG] Token refreshed.');
}

// ── 3. Ensure we always have a valid token ───────────────────────────────────
async function ensureToken() {
  if (!_accessToken) return authenticate();
  if (Date.now() >= _tokenExpiresAt) return refreshToken();
}

// ── 4. Generic authenticated GET with pagination ─────────────────────────────
// Resource Guru paginates using Link headers (page=N query param).
// We keep fetching until there is no "next" page.
async function getAllPages(path, params = {}) {
  await ensureToken();

  let results = [];
  let page = 1;
  const limit = params.limit || 100;   // max per page

  while (true) {
    const url = new URL(`${BASE}/${process.env.RG_ACCOUNT}${path}`);
    Object.entries({ ...params, page, per_page: limit }).forEach(([k, v]) => {
      if (v !== undefined) url.searchParams.set(k, v);
    });

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${_accessToken}` },
    });

    // Handle 429 Rate Limit
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
      console.warn(`[RG] Rate limited — waiting ${retryAfter}s`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`RG API ${res.status} on ${path}: ${body}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      // Some endpoints return an object, not an array
      return data;
    }

    results = results.concat(data);

    // Check for next page via X-Total-Count or just stop when fewer than limit
    if (data.length < limit) break;
    page++;
  }

  return results;
}

// ── 5. Specific fetchers the proxy needs ─────────────────────────────────────

/**
 * Fetch all active resources (people) from Resource Guru.
 * Returns: array of { id, name, job_title, resource_type, groups }
 */
async function fetchResources() {
  console.log('[RG] Fetching resources...');
  return getAllPages('/resources', { filter: 'active' });
}

/**
 * Fetch bookings within a date range.
 * @param {string} from  ISO date e.g. "2026-04-01"
 * @param {string} to    ISO date e.g. "2026-10-03"
 * Returns: array of booking objects
 */
async function fetchBookings(from, to) {
  console.log(`[RG] Fetching bookings ${from} → ${to}...`);
  return getAllPages('/bookings', { start_date: from, end_date: to, limit: 100 });
}

/**
 * Fetch the v2 resource utilisation report.
 * This is the most useful endpoint — returns pre-aggregated available/utilized
 * hours per resource per week, which maps directly to the dashboard's RAW shape.
 *
 * @param {string} from  ISO date
 * @param {string} to    ISO date
 */
async function fetchReport(from, to) {
  console.log(`[RG] Fetching utilisation report ${from} → ${to}...`);
  // Reports v2 endpoint — returns per-resource weekly breakdown
  const url = new URL(`${BASE}/${process.env.RG_ACCOUNT}/reports/resources`);
  url.searchParams.set('start_date', from);
  url.searchParams.set('end_date', to);

  await ensureToken();
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${_accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RG report ${res.status}: ${body}`);
  }
  return res.json();
}

module.exports = { authenticate, fetchResources, fetchBookings, fetchReport };
