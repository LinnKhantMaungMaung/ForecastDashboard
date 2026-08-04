// server/transformer.js
const { fetchReportRange, fetchResources, fetchResourceTypes, fetchProjects, fetchBookings, fetchDowntimes, fetchDowntimeTypes, sleep } = require('./resourceGuru');

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

function isEquipmentOrRoom(rtName) {
  return /vehicle|conference|meeting room|miscellaneous/i.test(rtName || '');
}
function isPlaceholder(rtName) {
  return /placeholder/i.test(rtName || '');
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

// ── Time Off / Downtime hours per resource per week ──────────────────────────
// Downtimes are a SEPARATE Resource Guru resource from Bookings entirely
// (confirmed via the RG UI's "Time Off" popup — a distinct black-bar style
// from colored project Bookings). Each event has resource_ids (an array —
// one event can cover several people), a from/to date range, and
// start_time/end_time in minutes-from-midnight applying per day in that
// range. Only "Approved" (not Pending/Declined) and non-deleted events count
// as real absence.
//
// This is currently DIAGNOSTIC ONLY — computed and logged so we can compare
// against Resource Guru's own "availability" figure (see the comparison in
// buildRawData below) before deciding whether availability needs a manual
// adjustment. If RG's own Report already nets Downtime out of availability
// (very plausible — that's the whole point of tracking Time Off), applying
// our own subtraction on top would double-count and make things WRONG in
// the other direction. Confirm from real data first.
//
// Returns: { hours: {"resourceId|weekLabel": hours}, types: {"resourceId|weekLabel": Set<typeName>} }
function buildDowntimeHoursByResourceWeek(downtimes, downtimeTypeNameById = {}) {
  const hours = {};
  const types = {};
  let approvedCount = 0, skippedCount = 0;
  for (const dt of downtimes) {
    if (dt.deleted) { skippedCount++; continue; }
    if (dt.state && dt.state !== 'Approved') { skippedCount++; continue; }
    approvedCount++;
    const typeName = downtimeTypeNameById[dt.downtime_type_id] || (dt.downtime_type_id == null ? '(no type)' : `type#${dt.downtime_type_id}`);
    const dayMins = Math.max(0, (dt.end_time ?? 1440) - (dt.start_time ?? 0));
    const dayHours = dayMins / 60;
    const start = new Date(dt.from + 'T00:00:00Z');
    const end   = new Date(dt.to   + 'T00:00:00Z');
    for (const resId of (dt.resource_ids || [])) {
      const cur = new Date(start);
      while (cur <= end) {
        const dow = cur.getUTCDay();
        if (dow !== 0 && dow !== 6) { // weekdays only
          const wk = toWeekLabel(cur);
          const key = `${resId}|${wk}`;
          hours[key] = (hours[key] || 0) + dayHours;
          if (!types[key]) types[key] = new Set();
          types[key].add(typeName);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
  }
  console.log(`[Transform] Downtime (Time Off): ${approvedCount} approved event(s) processed, ${skippedCount} skipped (deleted or not Approved)`);
  return { hours, types };
}

async function buildRawData(from, to) {
  const weeks = buildWeeks(from, to);
  console.log(`[Transform] Building data for ${weeks.length} weeks (${from} → ${to})`);

  // Dept option lookup and resource metadata — declared outside try so weekly loop can use them
  const deptOptionLookup   = {}; // option_id(number) → department name
  const CONTRACTOR_OPT_ID  = 172385; // custom_field 81461: 172385=Contractor
  let   resourceMeta       = {}; // name → { isEquipment, seniority, job_title }
  const resourceIdToName   = {}; // RG resource id → name (for the bookings breakdown below)
  const slaProjectIdToName = new Map(); // RG project id → name, only for "SLA ROTA..." projects
  let   slaRotaProjectNames = []; // full list of known rota project names, for the dashboard's checklist UI

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
        resourceMeta[r.name] = {
          isEquipment: isEquipmentOrRoom(rtName),
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

  // Time Off (Downtime) — fetched once for the whole range, same pattern as
  // Bookings. DIAGNOSTIC ONLY for now (see comparison against RG's own
  // "availability" figure in the per-resource loop below) — not yet applied
  // to available_hours until we've confirmed from real data whether RG
  // already nets it out automatically.
  let downtimeHoursByResourceWeek = {};
  let downtimeTypesByResourceWeek = {};
  try {
    const [downtimes, downtimeTypes] = await Promise.all([
      fetchDowntimes(from, to),
      fetchDowntimeTypes().catch(() => []),
    ]);
    const downtimeTypeNameById = {};
    (downtimeTypes || []).forEach(t => { downtimeTypeNameById[t.id] = t.name; });
    const result = buildDowntimeHoursByResourceWeek(downtimes, downtimeTypeNameById);
    downtimeHoursByResourceWeek = result.hours;
    downtimeTypesByResourceWeek = result.types;
  } catch (err) {
    console.warn('[Transform] Downtimes fetch failed — holiday/leave diagnostic will be skipped:', err.message);
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

      // Rooms/vehicles/misc are still fully excluded — never real capacity.
      if (isEquipmentOrRoom(rtName)) continue;

      // Placeholder resources (e.g. "PLC Commissioning Placeholder") represent
      // a department's UNASSIGNED work — bookings made before a specific
      // engineer is assigned. Previously these were silently dropped
      // entirely via the same filter as rooms/vehicles. Now tracked
      // separately, per department per week, as "unassigned_hours" on the
      // TEAM row (never as an individual engineer — there's no real person
      // to attribute it to).
      const isPlaceholderResource = isPlaceholder(rtName);

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

      // HOLIDAY/DOWNTIME DIAGNOSTIC: compare our own computed downtime
      // hours (from the real Time Off/Downtime API) against RG's own
      // "availability" figure for this exact resource+week. This tells us
      // definitively whether RG already nets Downtime out of availability:
      //   - if availability looks LOW/reduced despite full nominal capacity
      //     → RG already handles it, no fix needed here.
      //   - if availability looks FULL/unreduced despite known downtime
      //     → RG does NOT net it out automatically, and we need to manually
      //     subtract our computed downtime hours ourselves.
      const downtimeKey = `${r.id}|${wk.label}`;
      const downtimeHrsThisWeek = downtimeHoursByResourceWeek[downtimeKey];
      if (downtimeHrsThisWeek > 0) {
        const typeNames = [...(downtimeTypesByResourceWeek[downtimeKey] || [])].join('+') || 'unknown';
        console.log(`[Transform] DOWNTIME DIAGNOSTIC: ${name} has ${downtimeHrsThisWeek.toFixed(1)}h of approved Time Off [type: ${typeNames}] in week ${wk.label} — RG reports "availability"=${totalAvail}h for that same week. ${totalAvail < 5 ? '(looks ALREADY reduced — RG may be handling this correctly)' : '(looks FULL/unreduced — RG likely does NOT net this out automatically)'}`);
      }

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

  return {
    teams:          teams.sort((a, b) => a.week.localeCompare(b.week) || a.team.localeCompare(b.team)),
    engineers:      Object.values(engineersMap).sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name)),
    engineer_list:  Object.values(engineerList).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
    resource_types: [...new Set(Object.values(engineerList).map(e => e.resourceType))].sort(),
    meta: { fetched_at: new Date().toISOString(), weeks: weeks.length, sla_rota_projects: slaRotaProjectNames },
  };
}

module.exports = { buildRawData, toWeekLabel, buildWeeks, getTeamFromJobTitle, getSeniority };
