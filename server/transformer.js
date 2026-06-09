// server/transformer.js
// ─────────────────────────────────────────────────────────────────────────────
// Converts Resource Guru API responses into the RAW shape the dashboard needs:
//
//   RAW = {
//     teams:         [{ week, team, available_hours, utilized_hours, tentative_hours, headcount }],
//     engineers:     [{ week, name, team, job_title, available_hours, utilized_hours, tentative_hours, isContractor, seniority }],
//     engineer_list: [{ name, team, job_title, isContractor, resourceType, seniority, group }],
//     resource_types: [...unique type names],
//     meta:          { fetched_at, weeks }
//   }
//
// Team assignment priority:
//   1. RG Groups field (direct department data from RG)  ← most accurate
//   2. Job title regex mapping                           ← fallback
// ─────────────────────────────────────────────────────────────────────────────

const { fetchReportRange, fetchResources, fetchResourceTypes, sleep } = require('./resourceGuru');

// ── ISO week label "YYYY Www" ─────────────────────────────────────────────────
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

// Build array of { label, from, to } for each ISO week between two dates
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
      from:  monday.toISOString().slice(0, 10),
      to:    sunday.toISOString().slice(0, 10),
    });
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

// ── Team from job title (fallback when RG groups not available) ───────────────
function getTeamFromJobTitle(jt) {
  if (!jt) return 'Unassigned';
  if (/Installation Electrician|Electrical Labourer|QA Co-ordinator|\[SL\]Engineering Manager/i.test(jt)) return 'Electrical Installation';
  if (/PLC.?Amazon|Amazon/i.test(jt)) return 'PLC Amazon';
  if (/Controls Engineer|Head of Controls|Controls Manager|Controls Site/i.test(jt)) return 'PLC';
  if (/Project Engineer|Project Manager|Head of Automation|Head of Service|Automation Project|Senior Project/i.test(jt)) return 'Projects';
  if (/Service Engineer|Service Manager|Senior Service/i.test(jt)) return 'Service';
  if (/Design Engineer|Lead Design|Junior Design/i.test(jt)) return 'Design';
  if (/Software|WCS|WMS|Senior Software|Graduate Software/i.test(jt)) return 'HELIX';
  if (/Robotics/i.test(jt)) return 'Robotics';
  if (/Workshop|Apprentice/i.test(jt)) return 'Control Panels - Notts';
  if (/Director|Managing Director|Executive Director|Technical Director|Integration Director|Operations Director/i.test(jt)) return 'Director';
  if (/Accounts|Business Support|Supply Chain|Logistics/i.test(jt)) return 'Office';
  if (/R&D/i.test(jt)) return 'R&D Engineer';
  if (/Control Systems Business Development/i.test(jt)) return 'Control Systems Business Development Architect';
  return jt;
}

// ── Seniority from job title ──────────────────────────────────────────────────
function getSeniority(job_title) {
  const jt = job_title || '';
  if (/director|managing director|executive director|chief|group managing/i.test(jt)) return 'director';
  if (/\bmanager\b|head of|senior manager|lead controls|lead design/i.test(jt)) return 'manager';
  return 'staff';
}

// ── Main builder ──────────────────────────────────────────────────────────────
async function buildRawData(from, to) {
  const weeks = buildWeeks(from, to);
  console.log(`[Transform] Building data for ${weeks.length} weeks (${from} → ${to})`);
  const deptOptionLookup = {};
  // ── Step 1: Fetch resource metadata (groups, resource_type, job_title) ──────
  // This is the call that gives us real department/group data from RG.
  // Endpoint: GET /v1/{account}/resources
  let resourceMeta = {};   // name → { group, isContractor, isEquipment, seniority, resourceTypeName }
  try {
    const [resources, resourceTypes] = await Promise.all([
      fetchResources(),     // GET /v1/{account}/resources
      fetchResourceTypes(), // GET /v1/{account}/resource_types
    ]);

    // Build type id → name map
    const typeMap = {};
    if (Array.isArray(resourceTypes)) {
      resourceTypes.forEach(rt => { typeMap[rt.id] = rt.name; });
      console.log(`[Transform] Resource types from RG: ${resourceTypes.map(rt => rt.name).join(', ')}`);
    }

    // Build department option ID → name lookup from custom field 81460
    const deptOptionLookup = {};
    const personType = Array.isArray(resourceTypes) ? resourceTypes.find(rt => rt.id === 225004) : null;
    const deptField  = personType?.custom_fields?.find(cf => cf.id === 81460);
    if (deptField) {
      deptField.custom_field_options.forEach(opt => { deptOptionLookup[opt.id] = opt.value; });
      console.log(`[Transform] Department options loaded: ${Object.keys(deptOptionLookup).length}`);
    }

    if (Array.isArray(resources)) {
      resources.forEach(r => {
        // Department comes from custom_field 81460 (option IDs stored as array)
        const deptIds   = r.custom_fields?.['81460'] || [];
        const groupName = deptIds.length > 0 ? deptOptionLookup[deptIds[0]] : null;

        // Contractor/Employee from custom_field 81461 — option 172385 = Contractor
        const contractorIds = r.custom_fields?.['81461'] || [];
        const isContractor  = contractorIds.includes(172385);

        const rtName = r.resource_type?.name
          || typeMap[r.resource_type?.id]
          || 'Person';

        resourceMeta[r.name] = {
          group:            groupName,
          resourceTypeName: rtName,
          isContractor,
          isEquipment:      /equipment|machine|room|vehicle/i.test(rtName),
          seniority:        getSeniority(r.job_title),
          job_title:        r.job_title || '',
        };
      });

      // Log how many resources have groups vs not
      const withGroup    = Object.values(resourceMeta).filter(m => m.group).length;
      const withoutGroup = Object.values(resourceMeta).filter(m => !m.group).length;
      console.log(`[Transform] Resources with RG group: ${withGroup}, without (using job title): ${withoutGroup}`);
    }
  } catch (err) {
    console.warn('[Transform] Could not fetch resource metadata:', err.message);
  }

  // ── Step 2: Fetch weekly utilisation reports ──────────────────────────────
  // Endpoint: GET /v1/{account}/reports/resources?start_date=X&end_date=Y
  // Called once per week — gives booked/availability/waiting_list per resource.
  const teamsMap     = {};
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
      const name      = r.name;
      const job_title = r.job_title || '';
      const meta      = resourceMeta[name] || {
        group: null, isContractor: false, isEquipment: false,
        seniority: getSeniority(job_title), resourceTypeName: 'Person',
      };

      // Skip non-people (equipment, rooms etc)
      if (meta.isEquipment) continue;

      // Team: priority order:
      // 1. custom_fields from report data (most up-to-date, comes directly from RG)
      // 2. meta.group from pre-fetched /resources (also from RG)
      // 3. job title fallback
      const reportDeptIds = r.custom_fields?.['81460'] || [];
      const reportDept    = reportDeptIds.length > 0 ? deptOptionLookup[reportDeptIds[0]] : null;
      const team = reportDept || meta.group || getTeamFromJobTitle(job_title);
      const reportContractorIds    = r.custom_fields?.['81461'] || [];
      const isContractorFromReport = reportContractorIds.includes(172385);
      // RG reports values are in MINUTES — convert to hours
      const avail     = +((r.availability  || 0) / 60).toFixed(2);
      const util      = +((r.booked        || 0) / 60).toFixed(2);
      const tentative = +((r.waiting_list  || 0) / 60).toFixed(2);

      // Engineer list (unique per person, last-write wins for team assignment)
      engineerList[name] = {
        name, team, job_title,
        isContractor:  isContractorFromReport || meta.isContractor,
        resourceType:  meta.resourceTypeName,
        seniority:     meta.seniority,
        group:         reportDept || meta.group,  // null = team came from job title mapping
      };

      // Engineer weekly row
      engineersMap[`${name}|${wk.label}`] = {
        week: wk.label, name, team, job_title,
        available_hours: avail,
        utilized_hours:  util,
        tentative_hours: tentative,
        isContractor:    isContractorFromReport || meta.isContractor,
        seniority:       meta.seniority,
      };

      // Team weekly aggregate
      const teamKey = `${team}|${wk.label}`;
      if (!teamsMap[teamKey]) {
        teamsMap[teamKey] = {
          week: wk.label, team,
          available_hours: 0, utilized_hours: 0, tentative_hours: 0,
          _hc: new Set(),
        };
      }
      teamsMap[teamKey].available_hours += avail;
      teamsMap[teamKey].utilized_hours  += util;
      teamsMap[teamKey].tentative_hours += tentative;
      if (avail > 0 || util > 0) teamsMap[teamKey]._hc.add(name);
    }

    // Pace requests to stay under the 200/min rate limit
    await sleep(150);
    if ((i + 1) % 5 === 0) console.log(`[Transform] ${i + 1}/${weeks.length} weeks done`);
  }

  // Finalise teams (convert Set to count)
  const teams = Object.values(teamsMap).map(({ _hc, ...rest }) => ({
    ...rest,
    available_hours: +rest.available_hours.toFixed(2),
    utilized_hours:  +rest.utilized_hours.toFixed(2),
    tentative_hours: +rest.tentative_hours.toFixed(2),
    headcount: _hc.size,
  }));

  console.log(`[Transform] Done — ${teams.length} team-week rows, ${Object.keys(engineersMap).length} engineer-week rows`);

  return {
    teams:          teams.sort((a, b) => a.week.localeCompare(b.week) || a.team.localeCompare(b.team)),
    engineers:      Object.values(engineersMap).sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name)),
    engineer_list:  Object.values(engineerList).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
    resource_types: [...new Set(Object.values(engineerList).map(e => e.resourceType))].sort(),
    meta: { fetched_at: new Date().toISOString(), weeks: weeks.length },
  };
}

module.exports = { buildRawData, toWeekLabel, buildWeeks, getTeamFromJobTitle, getSeniority };
