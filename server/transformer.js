// server/transformer.js
const { fetchReportRange, fetchResources, fetchResourceTypes, sleep } = require('./resourceGuru');

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

// Fallback team from job title — only used if no department set in RG
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
  return 'Unassigned';
}

function getSeniority(job_title) {
  const jt = job_title || '';
  if (/director|managing director|executive director|chief|group managing/i.test(jt)) return 'director';
  if (/\bmanager\b|head of/i.test(jt)) return 'manager';
  return 'staff';
}

function isNonPerson(rtName) {
  return /vehicle|conference|meeting room|miscellaneous|placeholder/i.test(rtName || '');
}

async function buildRawData(from, to) {
  const weeks = buildWeeks(from, to);
  console.log(`[Transform] Building data for ${weeks.length} weeks (${from} → ${to})`);

  // Dept option lookup and resource metadata — declared outside try so weekly loop can use them
  const deptOptionLookup   = {}; // option_id(number) → department name
  const CONTRACTOR_OPT_ID  = 172385; // custom_field 81461: 172385=Contractor
  let   resourceMeta       = {}; // name → { isEquipment, seniority, job_title }

  try {
    const [resources, resourceTypes] = await Promise.all([
      fetchResources(),
      fetchResourceTypes(),
    ]);

    if (Array.isArray(resourceTypes)) {
      // Build department option ID → name map from custom field 81460 on Person type
      const personType = resourceTypes.find(rt => rt.id === 225004);
      const deptField  = personType?.custom_fields?.find(cf => cf.id === 81460);
      if (deptField?.custom_field_options) {
        deptField.custom_field_options.forEach(opt => {
          deptOptionLookup[Number(opt.id)] = opt.value;
          deptOptionLookup[String(opt.id)] = opt.value; // also index by string
        });
        console.log(`[Transform] Departments loaded: ${Object.values(deptOptionLookup).filter((v,i,a)=>a.indexOf(v)===i).join(', ')}`);
      }
    }

    if (Array.isArray(resources)) {
      resources.forEach(r => {
        const rtName = typeof r.resource_type === 'object'
          ? r.resource_type?.name
          : r.resource_type || 'Person';
        resourceMeta[r.name] = {
          isEquipment: isNonPerson(rtName),
          seniority:   getSeniority(r.job_title),
          job_title:   r.job_title || '',
          rtName,
        };
      });
      console.log(`[Transform] Resource metadata: ${Object.keys(resourceMeta).length} resources`);
    }
  } catch (err) {
    console.warn('[Transform] Metadata fetch failed:', err.message);
  }

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

      // Determine resource type — report returns it as a string e.g. "Person"
      const rtName = typeof r.resource_type === 'object'
        ? r.resource_type?.name
        : r.resource_type || resourceMeta[name]?.rtName || 'Person';

      // Skip non-person resources (vehicles, rooms, placeholders)
      if (isNonPerson(rtName)) continue;

      // ── Department: from custom_fields["81460"] array of option IDs ────
      // People with NO department set get "Unassigned"
      // People with MULTIPLE departments get one row per department (hours split)
      const rawDeptIds = r.custom_fields?.['81460'] || [];
      const deptNames  = rawDeptIds
        .map(id => deptOptionLookup[Number(id)] || deptOptionLookup[String(id)])
        .filter(Boolean);

      // If no department in RG custom fields, use job title fallback or Unassigned
      const departments = deptNames.length > 0 ? deptNames : [getTeamFromJobTitle(job_title)];

      // ── Contractor: custom_fields["81461"] — 172385 = Contractor ───────
      const contractorIds = r.custom_fields?.['81461'] || [];
      const isContractor  = contractorIds.map(Number).includes(CONTRACTOR_OPT_ID);

      // ── Seniority ───────────────────────────────────────────────────────
      // Use pre-fetched job_title from /resources if report job_title is empty
      const resolvedJobTitle = job_title || resourceMeta[name]?.job_title || '';
      const seniority = resourceMeta[name]?.seniority || getSeniority(resolvedJobTitle);

      // ── Hours (RG reports in MINUTES) ───────────────────────────────────
      const totalAvail     = +((r.availability || 0) / 60).toFixed(2);
      const totalUtil      = +((r.booked       || 0) / 60).toFixed(2);
      const totalTentative = +((r.waiting_list || 0) / 60).toFixed(2);

      // Split hours equally across departments if person has multiple
      const share = departments.length;
      const avail     = +(totalAvail     / share).toFixed(2);
      const util      = +(totalUtil      / share).toFixed(2);
      const tentative = +(totalTentative / share).toFixed(2);

      // Use primary (first) department for engineer list and weekly rows
      const primaryTeam = departments[0];

      // Engineer list — store all departments as array
      engineerList[name] = {
        name,
        team:         primaryTeam,
        departments,  // all departments this person belongs to
        job_title:    resolvedJobTitle,
        isContractor,
        resourceType: rtName,
        seniority,
      };

      // Engineer weekly row (primary team only for chart simplicity)
      engineersMap[`${name}|${wk.label}`] = {
        week: wk.label, name,
        team:            primaryTeam,
        departments,
        job_title:       resolvedJobTitle,
        available_hours: totalAvail,
        utilized_hours:  totalUtil,
        tentative_hours: totalTentative,
        isContractor,
        seniority,
      };

      // Team aggregates — contribute to ALL departments the person belongs to
      for (const team of departments) {
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

  const teamNames = [...new Set(teams.map(t => t.team))].sort();
  console.log(`[Transform] Done — ${teams.length} team-week rows, ${Object.keys(engineersMap).length} engineer-week rows`);
  console.log(`[Transform] Teams: ${teamNames.join(', ')}`);

  return {
    teams:          teams.sort((a, b) => a.week.localeCompare(b.week) || a.team.localeCompare(b.team)),
    engineers:      Object.values(engineersMap).sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name)),
    engineer_list:  Object.values(engineerList).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
    resource_types: [...new Set(Object.values(engineerList).map(e => e.resourceType))].sort(),
    meta: { fetched_at: new Date().toISOString(), weeks: weeks.length },
  };
}

module.exports = { buildRawData, toWeekLabel, buildWeeks, getTeamFromJobTitle, getSeniority };


// ── Bookings data builder ─────────────────────────────────────────────────────
// Fetches all bookings for the date range and builds the same structure
// as the Search sheet in the Excel export:
//   - Per-week: header stats, dept×category matrix, project list, people list
// This uses the same deptOptionLookup and date range as buildRawData.
// ─────────────────────────────────────────────────────────────────────────────

const { fetchBookingsForRange } = require('./resourceGuru');

async function buildBookingsData(from, to) {
  console.log(`[Bookings] Building bookings data ${from} → ${to}`);

  // Reuse dept option lookup from resource types
  const deptOptionLookup   = {};
  const CONTRACTOR_OPT_ID  = 172385;

  try {
    const { fetchResourceTypes } = require('./resourceGuru');
    const resourceTypes = await fetchResourceTypes();
    if (Array.isArray(resourceTypes)) {
      const personType = resourceTypes.find(rt => rt.id === 225004);
      const deptField  = personType?.custom_fields?.find(cf => cf.id === 81460);
      if (deptField?.custom_field_options) {
        deptField.custom_field_options.forEach(opt => {
          deptOptionLookup[Number(opt.id)] = opt.value;
          deptOptionLookup[String(opt.id)] = opt.value;
        });
      }
    }
  } catch(err) {
    console.warn('[Bookings] Could not load dept options:', err.message);
  }

  // Fetch all bookings for the range (paginated)
  const bookings = await fetchBookingsForRange(from, to);
  console.log(`[Bookings] Fetched ${bookings.length} bookings`);

  // Group bookings by ISO week label
  const byWeek = {};

  for (const b of bookings) {
    // Date → week label
    const date = new Date(b.start_date || b.date);
    const weekLabel = toWeekLabel(date);

    // Resource info
    const resourceName = b.resource?.name || b.resource_name || 'Unknown';
    const jobTitle     = b.resource?.job_title || '';

    // Department from custom fields
    const deptIds  = b.resource?.custom_fields?.['81460'] || [];
    const deptName = deptIds.length > 0
      ? (deptOptionLookup[Number(deptIds[0])] || deptOptionLookup[String(deptIds[0])] || 'Unknown')
      : getTeamFromJobTitle(jobTitle);

    // Contractor/Employee
    const contractorIds = b.resource?.custom_fields?.['81461'] || [];
    const isContractor  = contractorIds.map(Number).includes(CONTRACTOR_OPT_ID);
    const empType       = isContractor ? 'Contractor' : 'Employee';

    // Hours (RG stores duration in seconds or minutes depending on endpoint)
    // /bookings returns duration in minutes
    let hours = 0;
    if (b.duration)           hours = b.duration / 60;        // seconds → hours
    else if (b.minutes)       hours = b.minutes / 60;          // minutes → hours
    else if (b.hours)         hours = Number(b.hours);
    else if (b.booked_minutes) hours = b.booked_minutes / 60;

    // Project info
    const projectName = b.project?.name || b.project_name || 'No project assigned';
    const projectCode = b.project?.project_code || b.project?.code || b.project_id || '';

    // Booking category (from booking notes/details or activity type)
    // RG bookings have a 'details' field — map to Commissioning/Development/WCS PM/None
    // The Excel "Booking Field: Category" comes from a custom field on the booking
    // Check booking custom fields
    let category = 'None';
    if (b.custom_fields) {
      // Find the category custom field (usually called "Category" in RG)
      const catField = Object.entries(b.custom_fields).find(([k]) =>
        k.toLowerCase().includes('categor') || k === '81458' || k === '81459'
      );
      if (catField) category = catField[1] || 'None';
    }
    // Fallback: check activity type
    if (category === 'None' && b.activity_type?.name) {
      category = b.activity_type.name;
    }

    // Billable flag
    const billable       = b.billable !== false;
    const bookingStatus  = b.booking_type || b.status || 'confirmed';

    // Start/end dates
    const startDate = b.start_date ? b.start_date.slice(0, 10) : '';
    const endDate   = b.end_date   ? b.end_date.slice(0, 10)   : startDate;

    // Build week entry
    if (!byWeek[weekLabel]) {
      byWeek[weekLabel] = {
        header:      { projects: 0, empHours: 0, contractorHours: 0, totalHours: 0 },
        deptMatrix:  {},   // dept → { category → hours }
        projectMap:  {},   // "name|code" → { name, code, hours }
        peopleMap:   {},   // name → { name, hours, dept, empType, jobTitle, earliest, latest }
      };
    }
    const wk = byWeek[weekLabel];

    // Accumulate hours
    wk.header.totalHours += hours;
    if (isContractor) wk.header.contractorHours += hours;
    else              wk.header.empHours         += hours;

    // Dept matrix
    if (!wk.deptMatrix[deptName])           wk.deptMatrix[deptName] = {};
    if (!wk.deptMatrix[deptName][category]) wk.deptMatrix[deptName][category] = 0;
    wk.deptMatrix[deptName][category] += hours;

    // Project map
    const projKey = `${projectName}|${projectCode}`;
    if (!wk.projectMap[projKey]) wk.projectMap[projKey] = { name: projectName, code: String(projectCode), hours: 0 };
    wk.projectMap[projKey].hours += hours;

    // People map
    if (!wk.peopleMap[resourceName]) {
      wk.peopleMap[resourceName] = {
        name: resourceName, hours: 0, dept: deptName,
        empType, jobTitle,
        earliest: startDate, latest: endDate,
      };
    }
    wk.peopleMap[resourceName].hours += hours;
    if (startDate && (!wk.peopleMap[resourceName].earliest || startDate < wk.peopleMap[resourceName].earliest))
      wk.peopleMap[resourceName].earliest = startDate;
    if (endDate && endDate > wk.peopleMap[resourceName].latest)
      wk.peopleMap[resourceName].latest = endDate;
  }

  // Finalise: count unique projects per week, sort arrays
  const weeks = Object.keys(byWeek).sort();
  const weekly = {};

  for (const wk of weeks) {
    const d = byWeek[wk];
    d.header.projects     = Object.keys(d.projectMap).length;
    d.header.totalHours   = +d.header.totalHours.toFixed(2);
    d.header.empHours     = +d.header.empHours.toFixed(2);
    d.header.contractorHours = +d.header.contractorHours.toFixed(2);

    // Round dept matrix values
    for (const dept of Object.keys(d.deptMatrix)) {
      for (const cat of Object.keys(d.deptMatrix[dept])) {
        d.deptMatrix[dept][cat] = +d.deptMatrix[dept][cat].toFixed(2);
      }
    }

    weekly[wk] = {
      header:     d.header,
      deptMatrix: d.deptMatrix,
      projects:   Object.values(d.projectMap)
        .sort((a, b) => b.hours - a.hours)
        .map(p => ({ ...p, hours: +p.hours.toFixed(2) })),
      people: Object.values(d.peopleMap)
        .sort((a, b) => b.hours - a.hours)
        .map(p => ({ ...p, hours: +p.hours.toFixed(2) })),
    };
  }

  console.log(`[Bookings] Done — ${weeks.length} weeks built`);
  return { weeks, weekly };
}

module.exports = { buildRawData, buildBookingsData, toWeekLabel, buildWeeks, getTeamFromJobTitle, getSeniority };
