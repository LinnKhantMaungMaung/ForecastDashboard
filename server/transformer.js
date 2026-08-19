// server/transformer.js
const { fetchReportRange, fetchResources, fetchResourceDetail, fetchResourceTypes, fetchProjects, fetchBookings, sleep } = require('./resourceGuru');

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

// Fallback team from job title — DEPRECATED as a name-guessing mechanism.
// This used to hardcode specific team names per job-title pattern (e.g.
// "Software" -> "HELIX"), which goes stale every time the actual RG
// department structure changes — exactly what happened when HELIX was
// split into "HELIX - Product" / "HELIX - Project". Any hardcoded team
// name baked into our code can't follow that kind of change automatically;
// only RG's own Department custom field (read dynamically elsewhere in
// this file, via deptOptionLookup) can. So this is now just a bare
// fallback — 'Unassigned' honestly reflects "no department set in RG",
// which is the correct signal to fix in RG directly rather than have us
// silently paper over it with a guess that may not even be a real
// department anymore.
function getTeamFromJobTitle(jt) {
  return 'Unassigned';
}

function getSeniority(job_title) {
  const jt = job_title || '';
  if (/\bdirector\b|\bchief\b|group managing/i.test(jt)) return 'director';
  if (/\bmanager\b|\bhead of\b/i.test(jt)) return 'manager';
  return 'staff';
}

function isEquipmentOrRoom(rtName) {
  return /vehicle|conference|meeting room|miscellaneous/i.test(rtName || '');
}
function isPlaceholder(rtName, jobTitleLike) {
  // Confirmed via real data: this account's /resources endpoint returns the
  // job-title-equivalent as a field called "type" (e.g. "Design Engineer",
  // "Installation Electrician"), NOT "job_title" at all — "Placeholder" is
  // the value of THAT field for stand-in resources like "Sub Con Panel
  // Build" / "PLC SUB CONTRACT" / "Project Management Forecast...". Check
  // both possible field names via getJobTitleLike() below, since the
  // weekly Report endpoint's exact naming isn't separately confirmed —
  // safer to check both than assume either one exclusively.
  return /placeholder/i.test(jobTitleLike || '') || /placeholder/i.test(rtName || '');
}
// Resource Guru is inconsistent about which field carries the job-title-like
// value depending on the endpoint — /resources uses "type", other endpoints
// may use "job_title". Check both rather than assuming one.
function getJobTitleLike(r) {
  return r.job_title || r.type || '';
}

// ── SLA-rota bookings ────────────────────────────────────────────────────────
// Standing on-call/rota bookings (e.g. "SLA-ROTA NIGHTS ON CALL", "SLA ROTA-
// CONTROLS", "SLA ROTA - HELIX", etc.) are tracked SEPARATELY per-project
// from normal project hours, so the dashboard can offer an individual
// include/exclude checkbox per rota rather than one blanket toggle.
//
// IMPORTANT: this matches the "SLA ROTA" / "SLA-ROTA" PREFIX specifically,
// not just any project containing the substring "SLA" — the account also
// has ~33 entirely legitimate client projects with "SLA" in the name (e.g.
// "Salts Healthcare - SLA", "Amazon DXM3 SLA" — real ongoing support
// contracts), which must NOT be excluded from utilisation. Verified against
// the account's real project list: this pattern matches exactly the 6 rota
// projects and none of the 33 real client SLA contracts.
function isSlaRotaProject(name) {
  return /^sla[\s-]*rota/i.test((name || '').trim());
}

// A booking's own details/notes text matches the rota pattern — fallback
// for bookings with no recognized project_id (e.g. project deleted/renamed
// since the booking was made).
function bookingDetailsIsSlaRota(b) {
  const text = `${b.details || ''} ${b.notes || ''}`.trim();
  return isSlaRotaProject(text);
}

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
// (duration.waiting === true) are excluded entirely — they're a separate
// concept from "tentative" and aren't what that toggle means.
//
// SLA-rota bookings are bucketed PER PROJECT NAME (slaByProject), not into
// one combined pool, so each rota can be individually included/excluded
// client-side.
//
// slaProjectIdToName: Map<project_id, project_name> — only entries whose
// name matched isSlaRotaProject().
//
// Returns: { "resourceId|weekLabel": { confirmedMins, tentativeMins, slaByProject: { [projectName]: { confirmedMins, tentativeMins } } } }
function buildConfirmedTentativeBreakdown(bookings, slaProjectIdToName) {
  const breakdown = {};
  let slaCount = 0;
  for (const b of bookings) {
    const resId = b.resource_id;
    if (resId == null) continue;
    let slaProjectName = null;
    if (b.project_id != null && slaProjectIdToName.has(b.project_id)) {
      slaProjectName = slaProjectIdToName.get(b.project_id);
    } else if (bookingDetailsIsSlaRota(b)) {
      slaProjectName = (b.details || b.notes || '').trim() || 'SLA Rota (unspecified)';
    }
    if (slaProjectName) slaCount++;
    const isTentative = b.tentative === true;
    for (const d of (b.durations || [])) {
      if (d.waiting) continue; // waiting list ≠ tentative — excluded from this split
      const wk = toWeekLabel(new Date(d.date));
      const key = `${resId}|${wk}`;
      if (!breakdown[key]) breakdown[key] = { confirmedMins: 0, tentativeMins: 0, slaByProject: {} };
      if (slaProjectName) {
        if (!breakdown[key].slaByProject[slaProjectName]) breakdown[key].slaByProject[slaProjectName] = { confirmedMins: 0, tentativeMins: 0 };
        if (isTentative) breakdown[key].slaByProject[slaProjectName].tentativeMins += (d.duration || 0);
        else              breakdown[key].slaByProject[slaProjectName].confirmedMins += (d.duration || 0);
      } else {
        if (isTentative) breakdown[key].tentativeMins += (d.duration || 0);
        else              breakdown[key].confirmedMins += (d.duration || 0);
      }
    }
  }
  if (slaCount > 0) console.log(`[Transform] Tracked ${slaCount} SLA-rota booking(s) across ${slaProjectIdToName.size} known rota project(s), individually selectable`);
  return breakdown;
}

// NOTE ON HOLIDAY/TIME-OFF HANDLING: investigated whether Resource Guru's
// "availability" figure already nets out approved Time Off (a separate RG
// resource from Bookings — the "Downtimes" API). Confirmed against real
// account data: it does, proportionally, for both partial-week and
// full-week absences. E.g. multiple people taking 1/2/3 days off all showed
// availability implying the exact same full-week baseline for their
// individual schedule (e.g. 45.0h/week people: 1 day off -> 36h left, 2
// days off -> 27h left, 3 days off -> 18h left — all exactly proportional).
// No adjustment needed here — availability is already correct as-is.

async function buildRawData(from, to) {
  const weeks = buildWeeks(from, to);
  console.log(`[Transform] Building data for ${weeks.length} weeks (${from} → ${to})`);

  // Dept option lookup and resource metadata — declared outside try so weekly loop can use them
  const deptOptionLookup   = {}; // option_id(number) → department name
  const departmentFieldIdByResourceTypeId = {}; // resourceTypeId → custom_field id for "Department"
  const CONTRACTOR_OPT_ID  = 172385; // custom_field 81461: 172385=Contractor
  let   resourceMeta       = {}; // name → { isEquipment, seniority, job_title }
  const resourceIdToName   = {}; // RG resource id → name (for the bookings breakdown below)
  const slaProjectIdToName = new Map(); // RG project id → name, only for "SLA ROTA..." projects
  let   slaRotaProjectNames = []; // full list of known rota project names, for the dashboard's checklist UI
  const placeholderResourceInfo = new Map(); // RG resource id → { name, departments } for Placeholder-type resources

  try {
    const [resources, resourceTypes, projects] = await Promise.all([
      fetchResources(),
      fetchResourceTypes(),
      fetchProjects(),
    ]);

    // Department custom field ID → resourceTypeId → fieldId map. Resource
    // Guru defines custom fields PER RESOURCE TYPE independently, so
    // "Department" for Person and "Department" for Placeholder can (and
    // here, do) have entirely different numeric field IDs, even though the
    // UI shows the same concept for both. Previously this only looked at
    // the Person type's field (hardcoded id 81460), so Placeholder
    // resources' departments were never read at all — their custom_fields
    // live under a different key. Fixed by matching on the field NAME
    // ("Department") across every resource type, and merging all their
    // option lookups into the same shared deptOptionLookup (the option
    // VALUES like "Control Panels - Notts" are the same strings regardless
    // of which type's field ID points to them).
    if (Array.isArray(resourceTypes)) {
      resourceTypes.forEach(rt => {
        const deptField = rt.custom_fields?.find(cf => /department/i.test(cf.name || ''));
        if (deptField) {
          departmentFieldIdByResourceTypeId[rt.id] = deptField.id;
          (deptField.custom_field_options || []).forEach(opt => {
            deptOptionLookup[Number(opt.id)] = opt.value;
            deptOptionLookup[String(opt.id)] = opt.value; // also index by string
          });
        }
      });
      console.log(`[Transform] Departments loaded: ${Object.values(deptOptionLookup).filter((v,i,a)=>a.indexOf(v)===i).join(', ')}`);
      console.log(`[Transform] Department field ID per resource type: ${JSON.stringify(departmentFieldIdByResourceTypeId)}`);
    }

    if (Array.isArray(projects)) {
      const matched = projects.filter(p => isSlaRotaProject(p.name));
      matched.forEach(p => slaProjectIdToName.set(p.id, p.name));
      slaRotaProjectNames = matched.map(p => p.name).sort();
      console.log(`[Transform] SLA-rota projects found (${matched.length} of ${projects.length} total): ${slaRotaProjectNames.map(n => `"${n}"`).join(', ') || '(none)'}`);

      // HOLIDAY DIAGNOSTIC v2 — searching booking free-text notes (v1) found
      // only false positives: real project work that happens to mention
      // "holiday"/"sick"/"leave" in passing ("DWS Sick Scanner interface",
      // "Bank Holiday Weekend Working", "covering for Mike whilst he is on
      // holiday"). Same class of mistake SLA-rota matching made at first —
      // free text is too noisy. This instead searches actual PROJECT NAMES,
      // which is what correctly identified the real SLA-rota projects.
      const holidayProjects = projects.filter(p => /holiday|annual leave|\bleave\b|\bpto\b|day[\s-]?off|sickness|\bsick\b/i.test(p.name || ''));
      if (holidayProjects.length) {
        console.log(`[Transform] HOLIDAY DIAGNOSTIC v2 (project name match): found ${holidayProjects.length} project(s): ${holidayProjects.map(p => `"${p.name}" (id ${p.id})`).join(', ')}`);
      } else {
        console.warn(`[Transform] HOLIDAY DIAGNOSTIC v2: no project name matches holiday/leave/PTO/sick out of ${projects.length} total projects. This suggests holidays in this account are NOT tracked as a Booking against a Project at all — likely Resource Guru's separate Leave/Absence feature instead, which has its own API area we haven't pulled from yet. If that's the case, "availability" (see below) may or may not already reflect it depending on whether RG nets Leave against capacity automatically — worth confirming directly: open a person's RG profile for a week they were on holiday and check whether it shows as a Leave entry (usually a distinct color/label from normal Bookings) or an actual Booking.`);
      }
    } else {
      console.warn('[Transform] Projects fetch returned no array — SLA-rota matching will rely on booking-details text only');
    }

    if (Array.isArray(resources)) {
      resources.forEach(r => {
        const rtName = typeof r.resource_type === 'object'
          ? r.resource_type?.name
          : r.resource_type || 'Person';
        const jobTitleLike = getJobTitleLike(r);
        resourceMeta[r.name] = {
          isEquipment: isEquipmentOrRoom(rtName),
          seniority:   getSeniority(jobTitleLike),
          job_title:   jobTitleLike,
          rtName,
        };
        if (r.id != null) resourceIdToName[r.id] = r.name;
      });
      console.log(`[Transform] Resource metadata: ${Object.keys(resourceMeta).length} resources`);

      // DIAGNOSTIC: how many resources are detected as Placeholder (tracked
      // as unassigned team-level work) — confirmed via real data that this
      // account's /resources endpoint calls the job-title-equivalent field
      // "type" (e.g. "Design Engineer"), not "job_title" at all. Fixed via
      // getJobTitleLike() above, which checks both possible field names.
      const allTypeNames = [...new Set(resources.map(r => {
        const rt = typeof r.resource_type === 'object' ? r.resource_type?.name : r.resource_type;
        return rt || 'Person';
      }))].sort();
      const placeholderResources = resources.filter(r => {
        const rt = typeof r.resource_type === 'object' ? r.resource_type?.name : r.resource_type;
        return isPlaceholder(rt, getJobTitleLike(r));
      });
      // Weekly Report data (fetchReportRange) turned out to NOT include
      // Placeholder-type resources at all — Resource Guru appears to scope
      // utilisation reports to real staff by default, so the per-week loop
      // below never even sees them. Instead, resolve each Placeholder's
      // department(s) here and compute its actual hours afterward from
      // Bookings data directly (confirmedTentativeBreakdown), which —
      // confirmed via SLA-rota tracking already working — DOES include
      // every resource_id regardless of type.
      //
      // IMPORTANT: confirmed via real data that Resource Guru's API simply
      // does not expose custom_fields for Placeholder resources through
      // ANY endpoint we can reach — neither the bulk /resources list NOR
      // the individual /resources/:id detail endpoint returns it, even
      // though the RG UI clearly shows a Department set on them. Since
      // there's no reliable API path to this data, fall back to inferring
      // department from the resource's own NAME — these names are
      // consistently department-suggestive (e.g. "U PLC Commissioning",
      // "U Design", "HELIX Escalation Rota") — matched against the
      // account's real department list, longest names checked first so
      // e.g. "PLC - Amazon" wins over the more generic "PLC" when both
      // could apply.
      const realDepartmentNames = [...new Set(Object.values(deptOptionLookup))]
        .sort((a, b) => b.length - a.length);
      function inferDepartmentFromName(name) {
        const lower = (name || '').toLowerCase();
        for (const dept of realDepartmentNames) {
          if (lower.includes(dept.toLowerCase())) return dept;
        }
        // Manual keyword fallbacks for known abbreviations/synonyms that
        // don't literally contain the full department name as a substring.
        if (/\bamazon\b/i.test(name))               return 'PLC - Amazon';
        if (/\brobot/i.test(name))                   return 'Robotics';
        if (/\binstall\b/i.test(name))                return 'Electrical Installation';
        // "HELIX" alone no longer exists as a real department — it was
        // split into "HELIX - Product" / "HELIX - Project" (confirmed via
        // real account data). Names like "Helix Commissioning Support" or
        // "HELIX Escalation Rota" don't disambiguate which of the two they
        // belong to, so this defaults to "HELIX - Project" as the closer
        // reading (commissioning/escalation support reads as delivery
        // work, not product strategy) — but this is a genuine guess. If
        // it's wrong for a specific placeholder, that's a one-line fix
        // here rather than a real bug to chase further.
        if (/\bhelix\b/i.test(name))                 return 'HELIX - Project';
        if (/\bproject management\b/i.test(name))    return 'Projects';
        if (/\bpanel\b|\bsub ?con\b/i.test(name))    return 'Control Panels - Notts';
        if (/\bplc\b|\bcontrols\b/i.test(name))      return 'PLC';
        if (/\bservice\b|\bppm\b/i.test(name))       return 'Service';
        if (/\bdesign\b/i.test(name))                return 'Design';
        return null; // genuinely unknown — falls back to "Unassigned" below
      }

      for (const r of placeholderResources) {
        const resourceTypeId = typeof r.resource_type === 'object' ? r.resource_type?.id : null;
        const fieldId = resourceTypeId != null ? departmentFieldIdByResourceTypeId[resourceTypeId] : null;
        const rawDeptIds = (fieldId != null ? r.custom_fields?.[fieldId] : null) || r.custom_fields?.['81460'] || [];
        const deptNamesFromApi = rawDeptIds
          .map(id => deptOptionLookup[Number(id)] || deptOptionLookup[String(id)])
          .filter(Boolean);
        const inferred = inferDepartmentFromName(r.name);
        const departments = deptNamesFromApi.length > 0 ? deptNamesFromApi
                           : (inferred ? [inferred] : [getTeamFromJobTitle(getJobTitleLike(r))]);
        placeholderResourceInfo.set(r.id, { name: r.name, departments });
      }
      console.log(`[Transform] PLACEHOLDER department resolution (API data unavailable — inferred from name): ${[...placeholderResourceInfo.values()].map(v => `"${v.name}"→${v.departments.join('+')}`).join(', ')}`);
      console.log(`[Transform] PLACEHOLDER DIAGNOSTIC: all resource_type names in this account: ${allTypeNames.map(t => `"${t}"`).join(', ')}`);
      if (placeholderResources.length) {
        console.log(`[Transform] PLACEHOLDER DIAGNOSTIC: ${placeholderResources.length} resource(s) detected as Placeholder: ${placeholderResources.map(r => `"${r.name}"`).join(', ')}`);
      } else {
        console.warn(`[Transform] PLACEHOLDER DIAGNOSTIC: 0 resources matched isPlaceholder() out of ${resources.length} total (checked both resource_type and job_title for "placeholder").`);
        // Still 0 matches even checking job_title — "Placeholder" must live
        // in a different field than assumed. Dump the FULL raw object for
        // the specific known resource from the screenshot ("Sub Con Panel
        // Build"), or anything with "placeholder"/"sub con" in its name, so
        // we can see every field directly instead of guessing a third time.
        const rawCandidates = resources.filter(r =>
          /placeholder|sub con/i.test(r.name || '') ||
          JSON.stringify(r).toLowerCase().includes('placeholder')
        );
        if (rawCandidates.length) {
          console.log(`[Transform] PLACEHOLDER DIAGNOSTIC: found ${rawCandidates.length} resource(s) with "placeholder" or "sub con" somewhere in their raw data — full object(s):`);
          rawCandidates.slice(0, 3).forEach(r => console.log(`[Transform]   ${JSON.stringify(r)}`));
        } else {
          console.warn(`[Transform] PLACEHOLDER DIAGNOSTIC: no resource's raw JSON contains "placeholder" at all. Dumping first 3 resources' full raw objects for reference: ${resources.slice(0,3).map(r => JSON.stringify(r)).join(' | ')}`);
        }
      }
    }
  } catch (err) {
    console.warn('[Transform] Metadata fetch failed:', err.message);
  }

  // Fetch every Booking in the whole range ONCE (not per-week — much lighter
  // on the API than the existing weekly report loop), then bucket
  // confirmed/tentative/SLA minutes per resource per week ourselves from
  // each booking's durations.
  let confirmedTentativeBreakdown = {};
  try {
    const bookings = await fetchBookings(from, to);
    confirmedTentativeBreakdown = buildConfirmedTentativeBreakdown(bookings, slaProjectIdToName);
    console.log(`[Transform] Confirmed/tentative/SLA breakdown built from ${bookings.length} bookings`);
  } catch (err) {
    console.warn('[Transform] Bookings fetch failed — confirmed/tentative split will fall back to Report data (tentative and SLA hours will read as 0):', err.message);
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
      const job_title = getJobTitleLike(r);

      // Determine resource type — report returns it as a string e.g. "Person"
      const rtName = typeof r.resource_type === 'object'
        ? r.resource_type?.name
        : r.resource_type || resourceMeta[name]?.rtName || 'Person';

      // Rooms/vehicles/misc are still fully excluded — never real capacity.
      if (isEquipmentOrRoom(rtName)) continue;

      // Placeholder resources (e.g. "PLC Commissioning Placeholder") represent
      // a department's UNASSIGNED work — bookings made before a specific
      // engineer is assigned. Previously these were silently dropped
      // entirely via the same filter as rooms/vehicles. Now tracked
      // separately, per department per week, as "unassigned_hours" on the
      // TEAM row (never as an individual engineer — there's no real person
      // to attribute it to).
      const isPlaceholderResource = isPlaceholder(rtName, job_title || resourceMeta[name]?.job_title || '');

      // ── Department: from custom_fields[deptFieldId] array of option IDs ──
      // People with NO department set get "Unassigned"
      // People with MULTIPLE departments get one row per department (hours split)
      // Uses the correct field ID for THIS resource's own resource_type —
      // Resource Guru defines custom fields per resource type
      // independently, so different types can have different field IDs for
      // what's conceptually the same "Department" concept (confirmed: this
      // broke Placeholder resources' department resolution when hardcoded
      // to the Person type's field id).
      const weeklyResourceTypeId = typeof r.resource_type === 'object' ? r.resource_type?.id : null;
      const weeklyDeptFieldId = weeklyResourceTypeId != null ? departmentFieldIdByResourceTypeId[weeklyResourceTypeId] : null;
      const rawDeptIds = (weeklyDeptFieldId != null ? r.custom_fields?.[weeklyDeptFieldId] : null) || r.custom_fields?.['81460'] || [];
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
      // SLA-rota hours are kept SEPARATE, PER PROJECT (not folded into
      // utilized/tentative by default) so the dashboard can offer an
      // individual include/exclude checkbox per rota instead of one
      // blanket toggle or a hardcoded server-side exclusion.
      const bd = confirmedTentativeBreakdown[`${r.id}|${wk.label}`];
      const totalUtil      = bd ? +(bd.confirmedMins / 60).toFixed(2) : +((r.booked || 0) / 60).toFixed(2);
      const totalTentative = bd ? +(bd.tentativeMins / 60).toFixed(2) : 0;
      const slaByProjectHours = {};           // projectName → confirmed hours (this share)
      const slaByProjectTentativeHours = {};  // projectName → tentative hours (this share)
      if (bd?.slaByProject) {
        for (const [projName, mins] of Object.entries(bd.slaByProject)) {
          slaByProjectHours[projName]          = +((mins.confirmedMins / 60) / departments.length).toFixed(2);
          slaByProjectTentativeHours[projName] = +((mins.tentativeMins / 60) / departments.length).toFixed(2);
        }
      }

      // Split hours equally across departments if person has multiple
      const share = departments.length;
      const avail     = +(totalAvail     / share).toFixed(2);
      const util      = +(totalUtil      / share).toFixed(2);
      const tentative = +(totalTentative / share).toFixed(2);

      function ensureTeamRow(team) {
        const teamKey = `${team}|${wk.label}`;
        if (!teamsMap[teamKey]) {
          teamsMap[teamKey] = {
            week: wk.label, team,
            available_hours: 0, utilized_hours: 0, tentative_hours: 0,
            sla_rota_hours: {}, sla_rota_tentative_hours: {},
            unassigned_hours: 0, unassigned_tentative_hours: 0,
            unassigned_by_name_hours: {}, unassigned_by_name_tentative_hours: {},
            plc_subcontract_hours: 0, plc_subcontract_tentative_hours: 0,
            _hc: new Set(),
          };
        }
        return teamsMap[teamKey];
      }

      // Placeholder resources represent a department's UNASSIGNED work —
      // attribute their hours directly to the team row only (never to an
      // individual engineer — there's no real person to attribute it to,
      // and they must never appear in engineerList/engineersMap).
      if (isPlaceholderResource) {
        for (const team of departments) {
          const row = ensureTeamRow(team);
          row.unassigned_hours           = +((row.unassigned_hours || 0) + util).toFixed(2);
          row.unassigned_tentative_hours = +((row.unassigned_tentative_hours || 0) + tentative).toFixed(2);
          // Deliberately NOT added to _hc (headcount) — not a real person.
        }
        continue;
      }

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
        team:                        primaryTeam,
        departments,
        job_title:                   resolvedJobTitle,
        available_hours:             totalAvail,
        utilized_hours:              totalUtil,
        tentative_hours:             totalTentative,
        sla_rota_hours:              slaByProjectHours,
        sla_rota_tentative_hours:    slaByProjectTentativeHours,
        isContractor,
        seniority,
      };

      // Team aggregates — contribute to ALL departments the person belongs to
      for (const team of departments) {
        const row = ensureTeamRow(team);
        row.available_hours += avail;
        row.utilized_hours  += util;
        row.tentative_hours += tentative;
        for (const [projName, hrs] of Object.entries(slaByProjectHours)) {
          row.sla_rota_hours[projName] = +((row.sla_rota_hours[projName] || 0) + hrs).toFixed(2);
        }
        for (const [projName, hrs] of Object.entries(slaByProjectTentativeHours)) {
          row.sla_rota_tentative_hours[projName] = +((row.sla_rota_tentative_hours[projName] || 0) + hrs).toFixed(2);
        }
        if (avail > 0 || util > 0) row._hc.add(name);
      }
    }

    await sleep(150);
    if ((i + 1) % 5 === 0) console.log(`[Transform] ${i + 1}/${weeks.length} weeks done`);
  }

  // ── Unassigned (Placeholder) hours — computed from Bookings, not Report ────
  // Confirmed: the weekly /reports/resources endpoint never includes
  // Placeholder-type resources at all (they were correctly detected via
  // /resources above, but the per-week loop's isPlaceholderResource branch
  // never fired — because the resources it iterates simply never contained
  // them). Bookings data doesn't have this limitation — every resource_id
  // that has ANY booking appears in confirmedTentativeBreakdown regardless
  // of resource type, which is exactly how SLA-rota tracking already works
  // for any resource. So: for each known Placeholder, pull its hours
  // directly from that breakdown, per week, and attribute to its team row.
  //
  // SPECIAL CASE: "PLC SUB CONTRACT" is treated as real PLC team work (goes
  // into plc_subcontract_hours, contributing to PLC's solid utilisation
  // line alongside real engineers, toggled the same way as
  // Employees/Contractors) rather than the generic dashed "unassigned work"
  // overlay that every other Placeholder uses.
  const PLC_SUBCONTRACT_NAME = 'PLC SUB CONTRACT';
  let placeholderHoursFound = 0;
  const hoursPerPlaceholder = {}; // resource name -> total hours found in this range, for diagnostics
  const unassignedPlaceholderNames = new Set(); // every placeholder name EXCEPT PLC Sub Contract, for the individual checklist
  for (const [resId, info] of placeholderResourceInfo) {
    const isPlcSubContract = info.name.trim().toUpperCase() === PLC_SUBCONTRACT_NAME;
    if (!isPlcSubContract) unassignedPlaceholderNames.add(info.name);
    for (const wk of weeks) {
      const bd = confirmedTentativeBreakdown[`${resId}|${wk.label}`];
      if (!bd) continue;
      const confirmedHrs = +(bd.confirmedMins / 60).toFixed(2);
      const tentativeHrs = +(bd.tentativeMins / 60).toFixed(2);
      hoursPerPlaceholder[info.name] = +((hoursPerPlaceholder[info.name] || 0) + confirmedHrs + tentativeHrs).toFixed(2);
      if (confirmedHrs <= 0 && tentativeHrs <= 0) continue;
      placeholderHoursFound++;

      if (isPlcSubContract) {
        // Always PLC, regardless of whatever department inference produced
        // — the user wants this specifically counted as PLC team work.
        const teamKey = `PLC|${wk.label}`;
        if (!teamsMap[teamKey]) {
          teamsMap[teamKey] = {
            week: wk.label, team: 'PLC',
            available_hours: 0, utilized_hours: 0, tentative_hours: 0,
            sla_rota_hours: {}, sla_rota_tentative_hours: {},
            unassigned_hours: 0, unassigned_tentative_hours: 0,
            unassigned_by_name_hours: {}, unassigned_by_name_tentative_hours: {},
            plc_subcontract_hours: 0, plc_subcontract_tentative_hours: 0,
            _hc: new Set(),
          };
        }
        const row = teamsMap[teamKey];
        row.plc_subcontract_hours           = +((row.plc_subcontract_hours || 0) + confirmedHrs).toFixed(2);
        row.plc_subcontract_tentative_hours = +((row.plc_subcontract_tentative_hours || 0) + tentativeHrs).toFixed(2);
        continue;
      }

      const share = info.departments.length || 1;
      for (const team of info.departments) {
        const teamKey = `${team}|${wk.label}`;
        if (!teamsMap[teamKey]) {
          teamsMap[teamKey] = {
            week: wk.label, team,
            available_hours: 0, utilized_hours: 0, tentative_hours: 0,
            sla_rota_hours: {}, sla_rota_tentative_hours: {},
            unassigned_hours: 0, unassigned_tentative_hours: 0,
            unassigned_by_name_hours: {}, unassigned_by_name_tentative_hours: {},
            plc_subcontract_hours: 0, plc_subcontract_tentative_hours: 0,
            _hc: new Set(),
          };
        }
        const row = teamsMap[teamKey];
        row.unassigned_hours           = +((row.unassigned_hours || 0) + confirmedHrs / share).toFixed(2);
        row.unassigned_tentative_hours = +((row.unassigned_tentative_hours || 0) + tentativeHrs / share).toFixed(2);
        row.unassigned_by_name_hours[info.name] = +((row.unassigned_by_name_hours[info.name] || 0) + confirmedHrs / share).toFixed(2);
        row.unassigned_by_name_tentative_hours[info.name] = +((row.unassigned_by_name_tentative_hours[info.name] || 0) + tentativeHrs / share).toFixed(2);
        // Deliberately NOT added to _hc (headcount) — not a real person.
      }
    }
  }
  console.log(`[Transform] Unassigned (Placeholder) hours: ${placeholderHoursFound} resource-week entries with bookings found across ${placeholderResourceInfo.size} known Placeholder resource(s)`);
  console.log(`[Transform] Hours per individual Placeholder resource for ${from}→${to}: ${Object.entries(hoursPerPlaceholder).map(([n,h]) => `"${n}"=${h}h`).join(', ') || '(none had any bookings in this range)'}`);

  const teams = Object.values(teamsMap).map(({ _hc, ...rest }) => ({
    ...rest,
    available_hours:            +rest.available_hours.toFixed(2),
    utilized_hours:             +rest.utilized_hours.toFixed(2),
    tentative_hours:            +rest.tentative_hours.toFixed(2),
    unassigned_hours:           +(rest.unassigned_hours || 0).toFixed(2),
    unassigned_tentative_hours: +(rest.unassigned_tentative_hours || 0).toFixed(2),
    // sla_rota_hours / sla_rota_tentative_hours are already per-project
    // objects with rounded values from the loop above — nothing further to
    // round here.
    headcount: _hc.size,
  }));

  const teamNames = [...new Set(teams.map(t => t.team))].sort();
  console.log(`[Transform] Done — ${teams.length} team-week rows, ${Object.keys(engineersMap).length} engineer-week rows`);
  console.log(`[Transform] Teams: ${teamNames.join(', ')}`);

  // PLACEHOLDER DIAGNOSTIC (part 2): total unassigned hours that actually
  // made it into the final data, per team. If Placeholder resources WERE
  // detected above but this shows all zeros, it means they simply have no
  // bookings in this specific date range (not a bug) — check a range where
  // you know a Placeholder has bookings, like the one in your screenshot.
  const unassignedTotals = {};
  teams.forEach(t => {
    const total = (t.unassigned_hours || 0) + (t.unassigned_tentative_hours || 0);
    if (total > 0) unassignedTotals[t.team] = +((unassignedTotals[t.team] || 0) + total).toFixed(2);
  });
  const unassignedEntries = Object.entries(unassignedTotals);
  if (unassignedEntries.length) {
    console.log(`[Transform] PLACEHOLDER DIAGNOSTIC: unassigned hours found in final data for ${from}→${to}: ${unassignedEntries.map(([t,h]) => `${t}=${h}h`).join(', ')}`);
  } else {
    console.warn(`[Transform] PLACEHOLDER DIAGNOSTIC: 0 unassigned hours in the final data for ${from}→${to} across ALL teams. See the earlier PLACEHOLDER DIAGNOSTIC line for whether any Placeholder resources were detected at all — if some were detected but this is still 0, they simply have no bookings in this specific date range.`);
  }

  return {
    teams:          teams.sort((a, b) => a.week.localeCompare(b.week) || a.team.localeCompare(b.team)),
    engineers:      Object.values(engineersMap).sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name)),
    engineer_list:  Object.values(engineerList).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
    resource_types: [...new Set(Object.values(engineerList).map(e => e.resourceType))].sort(),
    meta: { fetched_at: new Date().toISOString(), weeks: weeks.length, sla_rota_projects: slaRotaProjectNames, unassigned_placeholder_names: [...unassignedPlaceholderNames].sort() },
  };
}

module.exports = { buildRawData, toWeekLabel, buildWeeks, getTeamFromJobTitle, getSeniority };
