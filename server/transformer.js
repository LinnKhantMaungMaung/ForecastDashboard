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
  const resources = Array.isArray(reportData)
    ? reportData
    : (reportData.resources || reportData.data || []);

  // Get team from custom_fields or job_title grouping
  // Since RG returns "Person" as resource_type for all,
  // we use job_title as the team proxy
  function getTeam(resource) {
    const jt = resource.job_title || '';
    if (jt.includes('Installation Electrician') || jt.includes('Engineering Manager') || jt.includes('QA') || jt.includes('Electrical Labourer')) return 'Electrical Installation';
    if (jt.includes('Controls Engineer') || jt.includes('Head of Controls') || jt.includes('Controls Manager')) return 'PLC';
    if (jt.includes('Project Engineer') || jt.includes('Project Manager') || jt.includes('Head of Automation') || jt.includes('Head of Service')) return 'Projects';
    if (jt.includes('Service Engineer') || jt.includes('Service Manager')) return 'Service';
    if (jt.includes('Design Engineer') || jt.includes('Lead Design')) return 'Design';
    if (jt.includes('Software') || jt.includes('WCS') || jt.includes('WMS')) return 'HELIX';
    if (jt.includes('Robotics')) return 'Robotics';
    if (jt.includes('Workshop') || jt.includes('Apprentice')) return 'Control Panels - Notts';
    if (jt.includes('Director') || jt.includes('Managing')) return 'Director';
    if (jt.includes('Accounts') || jt.includes('Business Support') || jt.includes('Supply Chain')) return 'Office';
    return jt || 'Unassigned';
  }

  const engineerList = {};
  const teamsMap = {};
  const engineersMap = {};

  for (const resource of resources) {
    const name = resource.name;
    const job_title = resource.job_title || '';
    const team = getTeam(resource);

    engineerList[name] = { name, team, job_title };

    // Use the weeks object if present, otherwise use aggregate totals
    const weeks = resource.weeks || {};
    const weekEntries = Object.entries(weeks);

    if (weekEntries.length > 0) {
      for (const [isoMonday, wdata] of weekEntries) {
        const weekLabel = toWeekLabel(new Date(isoMonday));
        const avail = wdata.available_hours || wdata.availability || 0;
        const util  = wdata.booked_hours || wdata.booked || 0;

        const engKey = `${name}|${weekLabel}`;
        if (!engineersMap[engKey]) {
          engineersMap[engKey] = { week: weekLabel, name, team, job_title, available_hours: 0, utilized_hours: 0 };
        }
        engineersMap[engKey].available_hours += avail;
        engineersMap[engKey].utilized_hours  += util;

        const teamKey = `${team}|${weekLabel}`;
        if (!teamsMap[teamKey]) {
          teamsMap[teamKey] = { week: weekLabel, team, available_hours: 0, utilized_hours: 0, _hc: new Set() };
        }
        teamsMap[teamKey].available_hours += avail;
        teamsMap[teamKey].utilized_hours  += util;
        teamsMap[teamKey]._hc.add(name);
      }
    }
  }

  const teams = Object.values(teamsMap).map(({ _hc, ...rest }) => ({ ...rest, headcount: _hc.size }));

  return {
    teams:         teams.sort((a, b) => a.week.localeCompare(b.week) || a.team.localeCompare(b.team)),
    engineers:     Object.values(engineersMap).sort((a, b) => a.week.localeCompare(b.week)),
    engineer_list: Object.values(engineerList).sort((a, b) => a.team.localeCompare(b.team)),
    meta: { fetched_at: new Date().toISOString(), resource_count: resources.length },
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
    const team = resource.resource_type?.name || resource.type || 'Unassigned';
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
