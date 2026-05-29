// server/transformer.js
// ─────────────────────────────────────────────────────────────────────────────
// Builds the dashboard RAW shape by calling the v2 report endpoint once per
// week. Each weekly report gives every resource's booked + available hours for
// that week, which we assemble into teams[] and engineers[] arrays.
// ─────────────────────────────────────────────────────────────────────────────

const { fetchReportRange, sleep } = require('./resourceGuru');

// ── ISO week label "YYYY Www" ────────────────────────────────────────────────
function toWeekLabel(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()} W${weekNo}`;
}

// ── Monday of the week containing a date ─────────────────────────────────────
function weekMonday(date) {
  const d = new Date(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - (day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

// ── Map job_title → team (RG returns "Person" as resource_type for everyone) ─
function getTeam(resource) {
  const jt = resource.job_title || '';
  if (/Installation Electrician|Engineering Manager|QA|Electrical Labourer/i.test(jt)) return 'Electrical Installation';
  if (/Controls Engineer|Head of Controls|Controls Manager|Controls Site/i.test(jt)) return 'PLC';
  if (/Project Engineer|Project Manager|Head of Automation|Head of Service/i.test(jt)) return 'Projects';
  if (/Service Engineer|Service Manager/i.test(jt)) return 'Service';
  if (/Design Engineer|Lead Design/i.test(jt)) return 'Design';
  if (/Software|WCS|WMS/i.test(jt)) return 'HELIX';
  if (/Robotics/i.test(jt)) return 'Robotics';
  if (/Workshop|Apprentice/i.test(jt)) return 'Control Panels - Notts';
  if (/Director|Managing/i.test(jt)) return 'Director';
  if (/Accounts|Business Support|Supply Chain/i.test(jt)) return 'Office';
  return jt || 'Unassigned';
}

// ── Build a list of weeks (Mon–Sun) between two dates ────────────────────────
function buildWeeks(from, to) {
  const weeks = [];
  let cur = weekMonday(new Date(from));
  const end = new Date(to);
  while (cur <= end) {
    const monday = new Date(cur);
    const sunday = new Date(cur);
    sunday.setDate(sunday.getDate() + 6);
    weeks.push({
      label:   toWeekLabel(monday),
      from:    monday.toISOString().slice(0, 10),
      to:      sunday.toISOString().slice(0, 10),
    });
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

<<<<<<< HEAD
// ── MAIN: fetch week-by-week and assemble RAW ────────────────────────────────
async function buildRawData(from, to) {
  const weeks = buildWeeks(from, to);
  console.log(`[Transform] Fetching ${weeks.length} weekly reports (${from} → ${to})...`);

  const teamsMap     = {};   // `${team}|${week}` → row
  const engineersMap = {};   // `${name}|${week}` → row
  const engineerList = {};   // name → { name, team, job_title }

  for (let i = 0; i < weeks.length; i++) {
    const wk = weeks[i];

    let report;
    try {
      report = await fetchReportRange(wk.from, wk.to);
    } catch (err) {
      console.warn(`[Transform] Week ${wk.label} failed: ${err.message}`);
      continue;
    }

    // Report may be { resources: [...] } or an array
    const resources = Array.isArray(report)
      ? report
      : (report.resources || report.data || []);

    for (const r of resources) {
      const name      = r.name;
      const job_title = r.job_title || '';
      const team      = getTeam(r);

      // RG report uses minutes for booked/availability — convert to hours.
      // "booked" and "availability" are in minutes (large numbers like 191941).
      const availMin = r.availability || 0;
      const bookedMin = r.booked || 0;
      const avail = +(availMin / 60).toFixed(2);
      const util  = +(bookedMin / 60).toFixed(2);

      engineerList[name] = { name, team, job_title };

      // Engineer row
      const engKey = `${name}|${wk.label}`;
=======
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
>>>>>>> 8e605bceaa7667cfe7af49d33740550954ac7e13
      engineersMap[engKey] = {
        week: wk.label, name, team, job_title,
        available_hours: avail, utilized_hours: util,
      };

      // Team aggregate
      const teamKey = `${team}|${wk.label}`;
      if (!teamsMap[teamKey]) {
        teamsMap[teamKey] = { week: wk.label, team, available_hours: 0, utilized_hours: 0, _hc: new Set() };
      }
      teamsMap[teamKey].available_hours += avail;
      teamsMap[teamKey].utilized_hours  += util;
      if (avail > 0 || util > 0) teamsMap[teamKey]._hc.add(name);
    }

    // Gentle pace: ~150ms between calls keeps us well under 200/min
    await sleep(150);

    if ((i + 1) % 5 === 0) console.log(`[Transform] ${i + 1}/${weeks.length} weeks done`);
  }

  const teams = Object.values(teamsMap).map(({ _hc, ...rest }) => ({
    ...rest,
    available_hours: +rest.available_hours.toFixed(2),
    utilized_hours:  +rest.utilized_hours.toFixed(2),
    headcount: _hc.size,
  }));

  console.log(`[Transform] Done: ${teams.length} team-week rows, ${Object.keys(engineersMap).length} engineer-week rows`);

  return {
    teams:         teams.sort((a, b) => a.week.localeCompare(b.week) || a.team.localeCompare(b.team)),
    engineers:     Object.values(engineersMap).sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name)),
    engineer_list: Object.values(engineerList).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
    meta: { fetched_at: new Date().toISOString(), weeks: weeks.length },
  };
}

module.exports = { buildRawData, toWeekLabel, buildWeeks, getTeam };
