// server/transformer.js
// ─────────────────────────────────────────────────────────────────────────────
// Converts Resource Guru API responses into the RAW shape the dashboard needs.
//
// Department and Contractor/Employee come from custom_fields in the report data:
//   custom_fields["81460"] = [<department_option_id>]   → Department name
//   custom_fields["81461"] = [172385=Contractor | 172386=Employee]
//
// The option ID → name mapping is built from /resource_types at startup.
// This means any department changes in Resource Guru are picked up automatically
// on the next cache refresh — no code changes needed.
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

// ── Job title fallback (only used if no department custom field in data) ───────
function getTeamFromJobTitle(jt) {
  if (!jt) return 'Unassigned';
  if (/Installation Electrician|Electrical Labourer|QA Co-ordinator|\[SL\]Engineering Manager/i.test(jt)) return 'Electrical Installation';
  if (/PLC.?Amazon|Amazon/i.test(jt)) return 'PLC - Amazon';
  if (/Controls Engineer|Head of Controls|Controls Manager|Controls Site/i.test(jt)) return 'PLC';
  if (/Project Engineer|Project Manager|Head of Automation|Head of Service|Automation Project|Senior Project/i.test(jt)) return 'Projects';
  if (/Service Engineer|Service Manager|Senior Service|Field Service/i.test(jt)) return 'Service';
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
  if (/\bmanager\b|head of/i.test(jt)) return 'manager';
  return 'staff';
}

// ── Skip non-billable placeholder/vehicle resource types ─────────────────────
function isNonPerson(resourceTypeName, name) {
  if (!resourceTypeName) return false;
  if (/vehicle|conference|meeting room|miscellaneous/i.test(resourceTypeName)) return true;
  // Placeholder resources start with "U " or are named patterns
  if (resourceTypeName === 'Placeholder') return true;
  return false;
}

// ── Main builder ──────────────────────────────────────────────────────────────
async function buildRawData(from, to) {
  const weeks = buildWeeks(from, to);
  console.log(`[Transform] Building data for ${weeks.length} weeks (${from} → ${to})`);

  // These lookups are built from /resource_types and used throughout
  // Declared outside try block so weekly loop can access them
  const deptOptionLookup       = {};  // option_id → department name  (custom field 81460)
  const contractorOptionId     = 172385; // custom field 81461: 172385=Contractor, 172386=Employee
  let resourceMeta             = {};  // name → { isEquipment, resourceTypeName, seniority }

  // ── Step 1: Fetch resource type definitions and resource metadata ─────────
  try {
    const [resources, resourceTypes] = await Promise.all([
      fetchResources(),     // GET /v1/{account}/resources
      fetchResourceTypes(), // GET /v1/{account}/resource_types
    ]);

    // Build resource type id → name map
    const typeMap = {};
    if (Array.isArray(resourceTypes)) {
      resourceTypes.forEach(rt => { typeMap[rt.id] = rt.name; });
      console.log(`[Transform] Resource types: ${resourceTypes.map(rt => rt.name).join(', ')}`);

      // Build department option ID → name lookup from custom field 81460
      // This is in the "Person" resource type's custom_fields
      const personType = resourceTypes.find(rt => rt.id === 225004);
      const deptField  = personType?.custom_fields?.find(cf => cf.id === 81460);
      if (deptField && Array.isArray(deptField.custom_field_options)) {
        deptField.custom_field_options.forEach(opt => {
          deptOptionLookup[opt.id] = opt.value;
        });
        console.log(`[Transform] Department lookup built: ${Object.keys(deptOptionLookup).length} options`);
        console.log(`[Transform] Departments: ${Object.values(deptOptionLookup).join(', ')}`);
      } else {
        console.warn('[Transform] Could not find department custom field 81460 in resource types');
      }
    }

    // Build per-resource metadata (equipment detection, seniority)
    if (Array.isArray(resources)) {
      resources.forEach(r => {
        const rtName = r.resource_type?.name || typeMap[r.resource_type?.id] || 'Person';
        resourceMeta[r.name] = {
          resourceTypeName: rtName,
          isEquipment: isNonPerson(rtName, r.name),
          seniority:   getSeniority(r.job_title),
        };
      });
      console.log(`[Transform] Resource metadata loaded for ${Object.keys(resourceMeta).length} resources`);
    }
  } catch (err) {
    console.warn('[Transform] Could not fetch resource metadata:', err.message);
  }

  // ── Step 2: Fetch weekly utilisation reports ──────────────────────────────
  // Each report call returns all resources with their custom_fields (including
  // department option IDs and contractor flag) for that specific week.
  // We use the deptOptionLookup built above to convert IDs to names.
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

      // Skip vehicles, rooms, placeholders
      const rtName = r.resource_type || resourceMeta[name]?.resourceTypeName || 'Person';
      if (isNonPerson(rtName, name)) continue;
      // Also skip placeholder-style names (starting with "U " = unassigned placeholders)
      if (/^U\s+/i.test(name) || name.startsWith('U ')) continue;

      // ── Department: read from custom_fields in report data ──────────────
      // custom_fields["81460"] contains array of option IDs e.g. ["383350"]
      // We map the first ID to a department name using deptOptionLookup
      const deptIds   = r.custom_fields?.['81460'] || [];
      const deptName  = deptIds.length > 0 ? deptOptionLookup[deptIds[0]] : null;
      const team      = deptName || getTeamFromJobTitle(job_title);

      // ── Contractor: read from custom_fields["81461"] ────────────────────
      // option 172385 = Contractor, 172386 = Employee
      const contractorIds  = r.custom_fields?.['81461'] || [];
      const isContractor   = contractorIds.includes(contractorOptionId) ||
                             contractorIds.includes(String(contractorOptionId));

      // ── Seniority: from job title ───────────────────────────────────────
      const meta     = resourceMeta[name] || {};
      const seniority = meta.seniority || getSeniority(job_title);

      // ── Hours (RG reports in MINUTES) ───────────────────────────────────
      const avail     = +((r.availability || 0) / 60).toFixed(2);
      const util      = +((r.booked       || 0) / 60).toFixed(2);
      const tentative = +((r.waiting_list || 0) / 60).toFixed(2);

      // Engineer list — unique per person, holds latest metadata
      engineerList[name] = {
        name, team, job_title,
        isContractor,
        resourceType: rtName,
        seniority,
        department: deptName, // direct from RG, null if not set
      };

      // Engineer weekly row
      engineersMap[`${name}|${wk.label}`] = {
        week: wk.label, name, team, job_title,
        available_hours: avail,
        utilized_hours:  util,
        tentative_hours: tentative,
        isContractor,
        seniority,
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

  console.log(`[Transform] Done — ${teams.length} team-week rows, ${Object.keys(engineersMap).length} engineer-week rows`);
  console.log(`[Transform] Teams found: ${[...new Set(teams.map(t => t.team))].sort().join(', ')}`);

  return {
    teams:          teams.sort((a, b) => a.week.localeCompare(b.week) || a.team.localeCompare(b.team)),
    engineers:      Object.values(engineersMap).sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name)),
    engineer_list:  Object.values(engineerList).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
    resource_types: [...new Set(Object.values(engineerList).map(e => e.resourceType))].sort(),
    meta: { fetched_at: new Date().toISOString(), weeks: weeks.length },
  };
}

module.exports = { buildRawData, toWeekLabel, buildWeeks, getTeamFromJobTitle, getSeniority };
