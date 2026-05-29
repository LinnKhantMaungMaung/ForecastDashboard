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
