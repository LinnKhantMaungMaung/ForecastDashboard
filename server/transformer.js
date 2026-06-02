// server/transformer.js
const { fetchReportRange, fetchResources, fetchResourceTypes, fetchBookingsForRange, sleep } = require('./resourceGuru');

// ── ISO week label ────────────────────────────────────────────────────────────
function toWeekLabel(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()} W${weekNo}`;
}

function weekMonday(date) {
  const d = new Date(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - (day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildWeeks(from, to) {
  const weeks = [];
  let cur = weekMonday(new Date(from));
  const end = new Date(to);
  while (cur <= end) {
    const monday = new Date(cur);
    const sunday = new Date(cur);
    sunday.setDate(sunday.getDate() + 6);
    weeks.push({
      label: toWeekLabel(monday),
      from: monday.toISOString().slice(0, 10),
      to: sunday.toISOString().slice(0, 10),
    });
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

// ── Team mapping from job title ───────────────────────────────────────────────
function getTeam(resource) {
  const jt = resource.job_title || '';
  // Department-based team names (from RG custom fields or type names if available)
  const dept = resource._dept || '';
  if (dept) return dept;

  if (/Installation Electrician|Electrical Labourer|QA Co-ordinator/i.test(jt)) return 'Electrical Installation';
  if (/Controls Engineer|Head of Controls|Controls Manager|Controls Site/i.test(jt)) return 'PLC';
  if (/PLC.?Amazon|Amazon/i.test(jt)) return 'PLC Amazon';
  if (/Project Engineer|Project Manager|Head of Automation|Head of Service|Automation Project|Senior Project/i.test(jt)) return 'Projects';
  if (/Service Engineer|Service Manager|Senior Service/i.test(jt)) return 'Service';
  if (/Design Engineer|Lead Design|Junior Design/i.test(jt)) return 'Design';
  if (/Software|WCS|WMS|Senior Software|Graduate Software/i.test(jt)) return 'HELIX';
  if (/Robotics/i.test(jt)) return 'Robotics';
  if (/Workshop|Apprentice/i.test(jt)) return 'Control Panels - Notts';
  if (/Director|Managing Director|Executive Director|Technical Director|Integration Director|Operations Director/i.test(jt)) return 'Director';
  if (/Accounts|Business Support|Supply Chain|Logistics/i.test(jt)) return 'Office';
  if (/Engineering Manager|\[SL\]/i.test(jt)) return 'Electrical Installation';
  if (/R&D|R&amp;D/i.test(jt)) return 'R&D Engineer';
  if (/Control Systems Business Development/i.test(jt)) return 'Control Systems Business Development Architect';
  return jt || 'Unassigned';
}

// ── Classify seniority level ──────────────────────────────────────────────────
function getSeniority(job_title) {
  const jt = (job_title || '').toLowerCase();
  if (/director|managing director|executive director|chief|ceo|cto|coo/i.test(jt)) return 'director';
  if (/manager|head of|senior manager/i.test(jt)) return 'manager';
  return 'staff';
}

// ── Main build function ───────────────────────────────────────────────────────
async function buildRawData(from, to) {
  const weeks = buildWeeks(from, to);
  console.log(`[Transform] Fetching ${weeks.length} weekly reports (${from} → ${to})...`);

  // Fetch resource metadata (includes resource_type for contractor detection)
  let resourceMeta = {};
  let resourceTypeMap = {}; // id → name
  try {
    const [resources, resourceTypes] = await Promise.all([
      fetchResources(),
      fetchResourceTypes(),
    ]);
    // Build resource type map
    if (Array.isArray(resourceTypes)) {
      resourceTypes.forEach(rt => { resourceTypeMap[rt.id] = rt.name; });
    }
    // Build resource metadata lookup by name
    if (Array.isArray(resources)) {
      resources.forEach(r => {
        const rtName = r.resource_type?.name || resourceTypeMap[r.resource_type?.id] || 'Person';
        resourceMeta[r.name] = {
          resourceTypeName: rtName,
          isContractor: /contractor/i.test(rtName),
          isEquipment: /equipment|machine|room/i.test(rtName),
          job_title: r.job_title || '',
          seniority: getSeniority(r.job_title),
        };
      });
    }
    console.log(`[Transform] Loaded metadata for ${Object.keys(resourceMeta).length} resources`);
    console.log(`[Transform] Resource types found: ${[...new Set(Object.values(resourceMeta).map(r => r.resourceTypeName))].join(', ')}`);
  } catch (err) {
    console.warn('[Transform] Could not fetch resource metadata:', err.message);
  }

  const teamsMap = {};
  const engineersMap = {};
  const engineerList = {};

  for (let i = 0; i < weeks.length; i++) {
    const wk = weeks[i];
    let report;
    try {
      report = await fetchReportRange(wk.from, wk.to);
    } catch (err) {
      console.warn(`[Transform] Week ${wk.label} failed: ${err.message}`);
      continue;
    }

    const resources = Array.isArray(report)
      ? report
      : (report.resources || report.data || []);

    for (const r of resources) {
      const name = r.name;
      const job_title = r.job_title || '';
      const meta = resourceMeta[name] || { resourceTypeName: 'Person', isContractor: false, isEquipment: false, seniority: getSeniority(job_title) };

      // Skip equipment/rooms
      if (meta.isEquipment) continue;

      const team = getTeam({ job_title, _dept: r._dept });
      const avail = +(( r.availability || 0) / 60).toFixed(2);
      const util  = +((r.booked || 0) / 60).toFixed(2);
      const tentative = +((r.waiting_list || 0) / 60).toFixed(2); // waiting_list = tentative in RG

      engineerList[name] = {
        name, team, job_title,
        isContractor: meta.isContractor,
        resourceType: meta.resourceTypeName,
        seniority: meta.seniority,
      };

      const engKey = `${name}|${wk.label}`;
      engineersMap[engKey] = {
        week: wk.label, name, team, job_title,
        available_hours: avail,
        utilized_hours: util,
        tentative_hours: tentative,
        isContractor: meta.isContractor,
        seniority: meta.seniority,
      };

      const teamKey = `${team}|${wk.label}`;
      if (!teamsMap[teamKey]) {
        teamsMap[teamKey] = {
          week: wk.label, team,
          available_hours: 0, utilized_hours: 0, tentative_hours: 0,
          headcount: 0, _hc: new Set(),
        };
      }
      teamsMap[teamKey].available_hours += avail;
      teamsMap[teamKey].utilized_hours  += util;
      teamsMap[teamKey].tentative_hours += tentative;
      if (avail > 0 || util > 0) teamsMap[teamKey]._hc.add(name);
    }

    await sleep(150);
    if ((i + 1) % 5 === 0) console.log(`[Transform] ${i + 1}/${weeks.length} weeks done`);
  }

  const teams = Object.values(teamsMap).map(({ _hc, ...rest }) => ({
    ...rest,
    available_hours: +rest.available_hours.toFixed(2),
    utilized_hours:  +rest.utilized_hours.toFixed(2),
    tentative_hours: +rest.tentative_hours.toFixed(2),
    headcount: _hc.size,
  }));

  console.log(`[Transform] Done: ${teams.length} team-week rows, ${Object.keys(engineersMap).length} engineer-week rows`);

  return {
    teams:         teams.sort((a, b) => a.week.localeCompare(b.week) || a.team.localeCompare(b.team)),
    engineers:     Object.values(engineersMap).sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name)),
    engineer_list: Object.values(engineerList).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
    resource_types: [...new Set(Object.values(engineerList).map(e => e.resourceType))].sort(),
    meta: { fetched_at: new Date().toISOString(), weeks: weeks.length },
  };
}

module.exports = { buildRawData, toWeekLabel, buildWeeks, getTeam, getSeniority };
