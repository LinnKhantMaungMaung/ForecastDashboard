// server/transformer.js
const { fetchReportRange, fetchResources, fetchResourceTypes, fetchProjects, fetchBookings, sleep } = require('./resourceGuru');

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
  if (/\bdirector\b|\bchief\b|group managing/i.test(jt)) return 'director';
  if (/\bmanager\b|\bhead of\b/i.test(jt)) return 'manager';
  return 'staff';
}

function isNonPerson(rtName) {
  return /vehicle|conference|meeting room|miscellaneous|placeholder/i.test(rtName || '');
}

// ── Excluded projects ──────────────────────────────────────────────────────
// Bookings under these projects (matched by name, case-insensitive) never
// count toward utilised/tentative hours — e.g. standing on-call/rota
// bookings that would otherwise inflate real project utilisation. Add more
// names here if other rota-style projects need the same treatment.
//
// Enter the plain project name only — do NOT include a "(Client Name)"
// suffix even if that's what you see in the Resource Guru scheduler UI.
// RG's UI displays bookings as "Project (Client)", but the underlying
// project's own `name` field is just the project part; the client name in
// parentheses is appended for display only and isn't part of the real name.
const EXCLUDED_PROJECT_NAMES = [
  'SLA-ROTA NIGHTS ON CALL',
  'SLA ROTA- CONTROLS',
];
// Strips a trailing "(...)" suffix (a client name someone may have copied in
// from the UI display) before comparing, so matching works whether or not
// that suffix is present on either side.
function normalizeProjectName(name) {
  return (name || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
const EXCLUDED_PROJECT_NAMES_NORMALIZED = new Set(EXCLUDED_PROJECT_NAMES.map(normalizeProjectName));

// ── Confirmed vs Tentative breakdown from real Bookings ──────────────────────
// Resource Guru's Report endpoint only exposes "booked" (confirmed AND
// tentative combined) and "waiting_list" (a DIFFERENT concept entirely —
// overflow bookings that don't fit within availability due to a clash, not
// tentative bookings). A booking can be flagged tentative and still fit
// perfectly within a person's availability, in which case it's baked into
// "booked" with no way to separate it out from that endpoint alone.
//
// To get a real split, we pull actual Bookings (which expose a per-booking
// "tentative" flag) once for the whole date range, then bucket each day's
// duration into the correct week, split by that flag. Waiting-list days
// (duration.waiting === true) are excluded from both buckets here — they're
// a separate concept from "tentative" and aren't what this toggle means.
// Bookings under an EXCLUDED_PROJECT_NAMES project are dropped entirely —
// they never contribute to confirmed or tentative hours either.
//
// Returns: { "resourceId|weekLabel": { confirmedMins, tentativeMins } }
function buildConfirmedTentativeBreakdown(bookings, excludedProjectIds) {
  const breakdown = {};
  let excludedCount = 0;
  for (const b of bookings) {
    const resId = b.resource_id;
    if (resId == null) continue;
    if (b.project_id != null && excludedProjectIds.has(b.project_id)) { excludedCount++; continue; }
    const isTentative = b.tentative === true;
    for (const d of (b.durations || [])) {
      if (d.waiting) continue; // waiting list ≠ tentative — excluded from this split
      const wk = toWeekLabel(new Date(d.date));
      const key = `${resId}|${wk}`;
      if (!breakdown[key]) breakdown[key] = { confirmedMins: 0, tentativeMins: 0 };
      if (isTentative) breakdown[key].tentativeMins += (d.duration || 0);
      else              breakdown[key].confirmedMins += (d.duration || 0);
    }
  }
  if (excludedCount > 0) console.log(`[Transform] Excluded ${excludedCount} bookings under excluded projects (${EXCLUDED_PROJECT_NAMES.join(', ')})`);
  return breakdown;
}

async function buildRawData(from, to) {
  const weeks = buildWeeks(from, to);
  console.log(`[Transform] Building data for ${weeks.length} weeks (${from} → ${to})`);

  // Dept option lookup and resource metadata — declared outside try so weekly loop can use them
  const deptOptionLookup   = {}; // option_id(number) → department name
  const CONTRACTOR_OPT_ID  = 172385; // custom_field 81461: 172385=Contractor
  let   resourceMeta       = {}; // name → { isEquipment, seniority, job_title }
  const resourceIdToName   = {}; // RG resource id → name (for the bookings breakdown below)
  const excludedProjectIds = new Set(); // RG project ids matching EXCLUDED_PROJECT_NAMES

  try {
    const [resources, resourceTypes, projects] = await Promise.all([
      fetchResources(),
      fetchResourceTypes(),
      fetchProjects(),
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

    if (Array.isArray(projects)) {
      projects.forEach(p => {
        if (EXCLUDED_PROJECT_NAMES_NORMALIZED.has(normalizeProjectName(p.name))) {
          excludedProjectIds.add(p.id);
        }
      });
      if (excludedProjectIds.size > 0) {
        console.log(`[Transform] Resolved ${excludedProjectIds.size} excluded project id(s) from name match`);
      } else {
        console.warn(`[Transform] No projects matched EXCLUDED_PROJECT_NAMES (${EXCLUDED_PROJECT_NAMES.join(', ')}) — check spelling/case against your RG project list`);
        // Print real project names containing "SLA" or "ROTA" (if any) so a
        // spelling/formatting mismatch is visible immediately from the logs,
        // instead of needing another round-trip to find the exact name.
        const candidates = projects
          .filter(p => /sla|rota/i.test(p.name || ''))
          .map(p => `"${p.name}" (id ${p.id})`);
        if (candidates.length) {
          console.warn(`[Transform] Closest real project name(s) found: ${candidates.join(', ')} — compare exact spelling/punctuation against EXCLUDED_PROJECT_NAMES above`);
        } else {
          console.warn(`[Transform] No project name containing "SLA" or "ROTA" found at all in this account's ${projects.length} projects — full list: ${projects.map(p => `"${p.name}"`).join(', ')}`);
        }
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
        if (r.id != null) resourceIdToName[r.id] = r.name;
      });
      console.log(`[Transform] Resource metadata: ${Object.keys(resourceMeta).length} resources`);
    }
  } catch (err) {
    console.warn('[Transform] Metadata fetch failed:', err.message);
  }

  // Fetch every Booking in the whole range ONCE (not per-week — much lighter
  // on the API than the existing weekly report loop), then bucket
  // confirmed/tentative minutes per resource per week ourselves from each
  // booking's durations, excluding any booking under an excluded project.
  let confirmedTentativeBreakdown = {};
  try {
    const bookings = await fetchBookings(from, to);
    confirmedTentativeBreakdown = buildConfirmedTentativeBreakdown(bookings, excludedProjectIds);
    console.log(`[Transform] Confirmed/tentative breakdown built from ${bookings.length} bookings`);
  } catch (err) {
    console.warn('[Transform] Bookings fetch failed — confirmed/tentative split will fall back to Report data (tentative will read as 0, excluded projects will NOT be filtered):', err.message);
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
      const totalAvail = +((r.availability || 0) / 60).toFixed(2);

      // Confirmed / tentative split now comes from real Bookings data, not
      // the Report endpoint's "booked" (which is confirmed+tentative
      // combined) — see buildConfirmedTentativeBreakdown() above. Falls
      // back to treating everything as confirmed (old behaviour) if the
      // bookings fetch failed for some reason, so the dashboard still shows
      // sensible totals rather than zeros.
      const bd = confirmedTentativeBreakdown[`${r.id}|${wk.label}`];
      const totalUtil      = bd ? +(bd.confirmedMins / 60).toFixed(2) : +((r.booked || 0) / 60).toFixed(2);
      const totalTentative = bd ? +(bd.tentativeMins / 60).toFixed(2) : 0;

      // Split hours equally across departments if person has multiple
      const share = departments.length;
      const avail     = +(totalAvail     / share).toFixed(2);
      const util      = +(totalUtil      / share).toFixed(2);
      const tentative = +(totalTentative / share).toFixed(2);

      // Use primary (first) department for engineer list and weekly rows
      const primaryTeam = departments[0];

      // Engineer list — store all departments as array
      // Only update engineerList if this week has better data than what we already have.
      // Critical: never overwrite a known director/manager seniority with 'staff'
      // (happens when report returns empty job_title in later weeks)
      const existing = engineerList[name];
      const bestSeniority = (existing?.seniority && existing.seniority !== 'staff')
        ? existing.seniority   // keep director/manager once identified
        : seniority;           // accept new value if existing is staff or unknown
      const bestJobTitle = resolvedJobTitle || existing?.job_title || '';

      engineerList[name] = {
        name,
        team:         primaryTeam,
        departments,
        job_title:    bestJobTitle,
        isContractor,
        resourceType: rtName,
        seniority:    bestSeniority,
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
