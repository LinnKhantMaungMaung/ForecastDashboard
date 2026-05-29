// server/transformer.js
// ─────────────────────────────────────────────────────────────────────────────
// Transforms Resource Guru API responses into the RAW object shape your
// existing dashboard already knows how to consume:
//
//   RAW = {
//     teams:    [{ week, team, available_hours, utilized_hours, headcount }],
//     engineers:[{ week, name, team, job_title, available_hours, utilized_hours }],
//     engineer_list: [{ name, team, job_title }]
//   }
//
// The dashboard renders from this shape without any other changes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a JS Date as "YYYY Www" — matching what the dashboard uses.
 * e.g. 2026-04-01 (Wednesday of W14) → "2026 W14"
 */
function toWeekLabel(date) {
  // ISO week number
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;   // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()} W${weekNo}`;
}

/**
 * Return the Monday of the ISO week containing the given date.
 */
function weekMonday(date) {
  const d = new Date(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - (day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Generate all Monday dates for ISO weeks between two dates.
 * Returns array of { label: "2026 W14", monday: Date }
 */
function allWeeksBetween(from, to) {
  const weeks = [];
  let cur = weekMonday(new Date(from));
  const end = new Date(to);
  while (cur <= end) {
    weeks.push({ label: toWeekLabel(cur), monday: new Date(cur) });
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROACH A: Transform using the /reports/resources v2 endpoint
// This is the preferred method — RG pre-aggregates the data for us.
//
// RG Report v2 shape (simplified):
// {
//   resources: [
//     {
//       id, name, email, job_title,
//       groups: [{ name }],          ← team name lives here
//       weeks: {
//         "2026-04-06": {            ← Monday of the week
//           available_hours: 45,
//           booked_hours: 32,        ← this is "utilized_hours"
//           ...
//         }
//       }
//     }
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────
function transformReport(reportData) {
  // reportData may be { resources: [...] } or an array directly
  const resources = Array.isArray(reportData)
    ? reportData
    : (reportData.resources || reportData.data || []);

  // ── Build engineers array (week-level rows) ─────────────────────────────
  const engineersMap = {};  // `${name}|${week}` → row
  const teamsMap = {};      // `${team}|${week}` → { avail, util, headcount: Set }
  const engineerList = {}; // name → { name, team, job_title }

  for (const resource of resources) {
    // Determine team name — use first group name, or "Unassigned"
    const team = (resource.groups && resource.groups[0])
      ? resource.groups[0].name
      : 'Unassigned';

    const name = resource.name;
    const job_title = resource.job_title || '';

    // Track unique engineers
    if (!engineerList[name]) {
      engineerList[name] = { name, team, job_title };
    }

    // Walk week entries
    const weeks = resource.weeks || {};
    for (const [isoMonday, wdata] of Object.entries(weeks)) {
      const weekLabel = toWeekLabel(new Date(isoMonday));
      const avail  = wdata.available_hours || 0;
      const util   = wdata.booked_hours    // v2 uses "booked_hours"
                  || wdata.utilized_hours  // fallback name
                  || 0;

      // Engineer row
      const engKey = `${name}|${weekLabel}`;
      if (!engineersMap[engKey]) {
        engineersMap[engKey] = {
          week: weekLabel, name, team, job_title,
          available_hours: 0, utilized_hours: 0,
        };
      }
      engineersMap[engKey].available_hours += avail;
      engineersMap[engKey].utilized_hours  += util;

      // Team aggregate row
      const teamKey = `${team}|${weekLabel}`;
      if (!teamsMap[teamKey]) {
        teamsMap[teamKey] = {
          week: weekLabel, team,
          available_hours: 0, utilized_hours: 0,
          _headcountSet: new Set(),
        };
      }
      teamsMap[teamKey].available_hours += avail;
      teamsMap[teamKey].utilized_hours  += util;
      if (avail > 0 || util > 0) {
        teamsMap[teamKey]._headcountSet.add(name);
      }
    }
  }

  // Finalise headcount (Set → count) and strip the private _headcountSet
  const teams = Object.values(teamsMap).map(row => {
    const { _headcountSet, ...rest } = row;
    return { ...rest, headcount: _headcountSet.size };
  });

  const engineers = Object.values(engineersMap);

  return {
    teams:         teams.sort((a, b) => a.week.localeCompare(b.week) || a.team.localeCompare(b.team)),
    engineers:     engineers.sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name)),
    engineer_list: Object.values(engineerList).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
    meta: {
      fetched_at: new Date().toISOString(),
      resource_count: resources.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROACH B: Transform from raw bookings + resources (fallback)
// Used if the /reports endpoint is unavailable or returns unexpected data.
//
// This builds the same RAW shape by iterating over individual bookings.
// ─────────────────────────────────────────────────────────────────────────────
function transformFromBookings(resources, bookings) {
  // Build a lookup: resource_id → { name, team, job_title }
  const resourceInfo = {};
  for (const r of resources) {
    const team = (r.groups && r.groups[0]) ? r.groups[0].name : 'Unassigned';
    resourceInfo[r.id] = { name: r.name, team, job_title: r.job_title || '' };
  }

  // We need to know available hours per resource per week.
  // RG bookings don't include available hours directly — we need the resource's
  // working hours. As a reasonable default, assume 45h/week per resource and
  // mark it clearly in meta. A production system should fetch custom availability
  // from /custom_availability or use the reports endpoint instead.
  const ASSUMED_WEEKLY_HOURS = 45;

  // Collect booked hours per (resource, week)
  const bookedMap = {};   // `${resourceId}|${weekLabel}` → hours
  const resourceWeeks = {}; // resourceId → Set of week labels

  for (const booking of bookings) {
    const info = resourceInfo[booking.resource_id];
    if (!info) continue;  // skip unknown resources

    // Each booking has start_date and end_date + duration_in_seconds (per day)
    // or just booked_time. RG bookings are per-day; we roll up to weeks.
    const startDate = new Date(booking.start_date);
    const endDate   = new Date(booking.end_date);

    // Walk each day of the booking and accumulate hours by week
    const cur = new Date(startDate);
    while (cur <= endDate) {
      // Skip weekends
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) {
        const weekLabel = toWeekLabel(cur);
        const key = `${booking.resource_id}|${weekLabel}`;
        const dailyHours = (booking.duration || booking.booked_seconds || 28800) / 3600; // default 8h
        bookedMap[key] = (bookedMap[key] || 0) + dailyHours;

        if (!resourceWeeks[booking.resource_id]) resourceWeeks[booking.resource_id] = new Set();
        resourceWeeks[booking.resource_id].add(weekLabel);
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  // Build engineer rows for every resource × week they appear in
  const engineersMap = {};
  const teamsMap = {};
  const engineerList = {};

  for (const [resourceId, info] of Object.entries(resourceInfo)) {
    engineerList[info.name] = { name: info.name, team: info.team, job_title: info.job_title };
    const weeks = resourceWeeks[resourceId] || new Set();
    for (const weekLabel of weeks) {
      const key = `${resourceId}|${weekLabel}`;
      const util  = bookedMap[key] || 0;
      const avail = ASSUMED_WEEKLY_HOURS;

      const engKey = `${info.name}|${weekLabel}`;
      engineersMap[engKey] = {
        week: weekLabel, name: info.name, team: info.team, job_title: info.job_title,
        available_hours: avail, utilized_hours: util,
      };

      const teamKey = `${info.team}|${weekLabel}`;
      if (!teamsMap[teamKey]) {
        teamsMap[teamKey] = { week: weekLabel, team: info.team, available_hours: 0, utilized_hours: 0, _hc: new Set() };
      }
      teamsMap[teamKey].available_hours += avail;
      teamsMap[teamKey].utilized_hours  += util;
      teamsMap[teamKey]._hc.add(info.name);
    }
  }

  const teams = Object.values(teamsMap).map(({ _hc, ...rest }) => ({ ...rest, headcount: _hc.size }));

  return {
    teams:         teams.sort((a, b) => a.week.localeCompare(b.week)),
    engineers:     Object.values(engineersMap).sort((a, b) => a.week.localeCompare(b.week)),
    engineer_list: Object.values(engineerList),
    meta: {
      fetched_at: new Date().toISOString(),
      note: 'Available hours are estimated at 45h/week. Use the reports endpoint for accuracy.',
    },
  };
}

module.exports = { transformReport, transformFromBookings, toWeekLabel, allWeeksBetween };
