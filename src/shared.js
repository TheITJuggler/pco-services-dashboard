// Shared logic for PCO Team Report
// Used by both Cloudflare Worker (index.js) and local Node.js server (local-server.js)

import { ORG } from "./config.js";

// --- Date helper — org-local "YYYY-MM-DD" ---

function localDateStr(d) {
  return d.toLocaleDateString('en-CA', { timeZone: ORG.timezone || 'UTC' });
}

// --- PCO API helpers ---

function pcoHeaders(env) {
  const encoded = typeof btoa !== "undefined"
    ? btoa(`${env.PCO_APP_ID}:${env.PCO_SECRET}`)
    : Buffer.from(`${env.PCO_APP_ID}:${env.PCO_SECRET}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    Accept: "application/json",
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _apiCallCount = 0;

async function pcoFetch(env, url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: pcoHeaders(env) });
    if (res.status === 429) {
      const waitSec = parseInt(res.headers.get("Retry-After") || "5", 10);
      console.log(`  Rate limited, waiting ${waitSec}s (attempt ${attempt + 1})...`);
      await delay(waitSec * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PCO API ${res.status} at ${url}: ${body.substring(0, 200)}`);
    }
    _apiCallCount++;
    return res.json();
  }
  throw new Error(`PCO API rate limit exceeded after ${retries} retries: ${url}`);
}

async function pcoFetchAll(env, url) {
  let results = [];
  let included = [];
  let nextUrl = url;
  while (nextUrl) {
    const json = await pcoFetch(env, nextUrl);
    results = results.concat(json.data || []);
    if (Array.isArray(json.included)) included = included.concat(json.included);
    nextUrl = json.links?.next || null;
  }
  return { data: results, included };
}

// --- Extract short service time label from service type name ---
function extractTimeLabel(stName) {
  const m = stName.match(/(\d{1,2})\s*(AM|PM)/i);
  if (m) return `${m[1]}${m[2].toLowerCase()}`;
  return stName;
}

// --- Data fetching ---

async function fetchTeamData(env, teamConfig) {
  const BASE = "https://api.planningcenteronline.com/services/v2";
  _apiCallCount = 0;
  const _startTime = Date.now();
  const { slug, label, folderIds, filterFn, trackAttendance = true } = teamConfig;

  // 1. Get service types across all configured folders
  console.log(`[${slug}] Fetching service types from ${folderIds.length} folder(s)...`);
  const allServiceTypes = (await Promise.all(
    folderIds.map(fid => pcoFetchAll(env, `${BASE}/folders/${fid}/service_types`).then(r => r.data))
  )).flat();
  console.log(`[${slug}] Found ${allServiceTypes.length} service type(s): ${allServiceTypes.map(s => s.attributes.name).join(", ")}`);

  // 2. Fetch teams for each service type, filter using teamConfig.filterFn
  console.log(`[${slug}] Scanning for matching teams...`);
  const serviceTypeTeams = await Promise.all(
    allServiceTypes.map(async (st) => {
      try {
        const teams = await pcoFetchAll(env, `${BASE}/service_types/${st.id}/teams?per_page=100`);
        const matchingTeams = teams.data.filter(t => filterFn((t.attributes.name || "").toLowerCase()));
        return { st, matchedTeams: matchingTeams };
      } catch {
        return { st, matchedTeams: [] };
      }
    })
  );

  const withMatched = serviceTypeTeams.filter((x) => x.matchedTeams.length > 0);
  console.log(`[${slug}] Teams found:`);
  for (const { st, matchedTeams } of withMatched) {
    console.log(`  ${st.attributes.name}: ${matchedTeams.map(t => t.attributes.name).join(", ")}`);
  }

  // 3. Fetch all team members directly from each matched team to capture positions
  //    for everyone — including members not rostered within the current date range.
  const positionMap = new Map(); // personId -> Set of position names
  const memberAddedMap = new Map(); // personId -> ISO date string (earliest assignment created_at)
  console.log(`[${slug}] Fetching team member positions...`);
  await Promise.all(
    withMatched.flatMap(({ st, matchedTeams }) =>
      matchedTeams.map(async (team) => {
        try {
          // person_team_position_assignments links a person to a team position.
          // We also need team_positions to resolve position names.
          const [{ data: assignments }, { data: positions }] = await Promise.all([
            pcoFetchAll(env, `${BASE}/teams/${team.id}/person_team_position_assignments?per_page=200`),
            pcoFetchAll(env, `${BASE}/teams/${team.id}/team_positions?per_page=200`),
          ]);
          // Build position id -> name lookup
          const posNameById = new Map(positions.map(p => [p.id, (p.attributes.name || "").toLowerCase()]));

          for (const a of assignments) {
            const personId = a.relationships?.person?.data?.id;
            if (!personId) continue;
            // Ensure every assigned person is in positionMap (even with no named position)
            if (!positionMap.has(personId)) positionMap.set(personId, new Set());
            // Track earliest created_at for "New" badge
            const createdAt = a.attributes?.created_at;
            if (createdAt) {
              const existing = memberAddedMap.get(personId);
              if (!existing || createdAt < existing) memberAddedMap.set(personId, createdAt);
            }
            const posId = a.relationships?.team_position?.data?.id;
            if (!posId) continue;
            const posName = posNameById.get(posId);
            if (posName) positionMap.get(personId).add(posName);
          }
        } catch (err) {
          console.log(`  Could not fetch team members for team ${team.id}: ${err.message}`);
        }

      })
    )
  );
  console.log(`[${slug}] Team positions loaded for ${positionMap.size} member(s)`);


  // 4. Fetch plans — window driven by config
  const _pastMonths   = (ORG.window && ORG.window.pastMonths)   || 2;
  const _futureMonths = (ORG.window && ORG.window.futureMonths) || 3;
  const now = new Date();
  const _todayLocal = localDateStr(now);
  const past = new Date(now);
  past.setMonth(past.getMonth() - _pastMonths);
  const future = new Date(now);
  future.setMonth(future.getMonth() + _futureMonths);
  const afterParam = past.toISOString().split("T")[0];
  const beforeParam = future.toISOString().split("T")[0];
  console.log(`[${slug}] Fetching plans from ${afterParam} to ${beforeParam}...`);

  // Consolidated list of all plan columns across all services
  // Each entry: { key, sortDate, label, serviceTime, planId, stId }
  const allColumns = [];
  // Map: personId -> { name, statuses: Map<columnKey, status>, attended: Map<columnKey, boolean>, blockedOut: Map<columnKey, boolean> }
  const peopleMap = new Map();

  for (const { st, matchedTeams } of withMatched) {
    const stId = st.id;
    const stName = st.attributes.name;
    const timeLabel = extractTimeLabel(stName);

    const matchedTeamIds = new Set(matchedTeams.map(t => t.id));

    // 3. Fetch plans for this service type in the date range
    const { data: plans } = await pcoFetchAll(
      env,
      `${BASE}/service_types/${stId}/plans?filter=after,before&after=${afterParam}&before=${beforeParam}&order=sort_date&per_page=100`
    );

    if (plans.length === 0) {
      console.log(`  ${stName}: no plans in date range`);
      continue;
    }
    console.log(`  ${stName}: ${plans.length} plan(s)`);

    const pastPlans = plans.filter(p => (p.attributes.sort_date || p.attributes.dates || '').slice(0, 10) <= _todayLocal);

    // 4. Fetch team_members and attendances for all plans in parallel.
    //    Both calls are per-plan (PCO has no service-type-level endpoint for either),
    //    but Promise.all means all plans within a service type resolve concurrently
    //    rather than sequentially — wall-clock time equals the slowest single plan.
    console.log(`  ${stName}: fetching members${trackAttendance ? " + attendances" : ""} in parallel (${plans.length} plans${trackAttendance ? ", " + pastPlans.length + " past" : ""})...`);

    const membersByPlanId = new Map();
    const attendanceByPlanId = new Map();

    await Promise.all(
      plans.map(async (plan) => {
        const sortDate = plan.attributes.sort_date || plan.attributes.dates;
        const isPast = sortDate.slice(0, 10) <= _todayLocal;
        try {
          const [{ data: members }, attendances] = await Promise.all([
            pcoFetchAll(env, `${BASE}/service_types/${stId}/plans/${plan.id}/team_members?per_page=200`),
            (trackAttendance && isPast)
              ? pcoFetchAll(env, `${BASE}/service_types/${stId}/plans/${plan.id}/attendances?per_page=200`).then(r => r.data)
              : Promise.resolve([]),
          ]);
          membersByPlanId.set(plan.id, members);
          if (trackAttendance && isPast) attendanceByPlanId.set(plan.id, attendances);


        } catch {
          console.log(`  Skipped plan ${plan.id} due to error`);
        }
      })
    );

    // Build columns and peopleMap from fetched data
    for (const plan of plans) {
      try {
        const sortDate = plan.attributes.sort_date || plan.attributes.dates;
        const members = membersByPlanId.get(plan.id) || [];
        const attendances = attendanceByPlanId.get(plan.id) || [];

        const attendedPPIds = new Set(
          attendances.map((a) => a.relationships?.plan_person?.data?.id).filter(Boolean)
        );

        const matchedMembers = members.filter(
          (tm) => matchedTeamIds.has(tm.relationships?.team?.data?.id)
        );
        if (matchedMembers.length === 0) continue;

        const colKey = `${stId}_${plan.id}`;

        allColumns.push({
          key: colKey,
          sortDate,
          label: `${timeLabel} ${formatDate(sortDate)}`,
          timeLabel,
          planId: plan.id,
          stId,
          hasAttendance: attendances.length > 0,
          title:  plan.attributes.title        || null,
          series: plan.attributes.series_title  || null,
        });

        for (const tm of matchedMembers) {
          const personId = tm.relationships?.person?.data?.id || tm.id;
          const name = tm.attributes.name;
          const status = (tm.attributes.status || "").toUpperCase();
          const didAttend = attendedPPIds.has(tm.id);
          const prepareNotif = tm.attributes.prepare_notification === true;
          const notifSentAt = tm.attributes.notification_sent_at || null;
          const statusUpdatedAt = tm.attributes.status_updated_at || null;
          const declineReason = tm.attributes.decline_reason || null;

          if (!peopleMap.has(personId)) {
            const thumb = tm.attributes.photo_thumbnail || null;
            const isInitials = !thumb || thumb.includes("/initials/");
            // Seed positions from team-level membership fetch (step 3)
            const seedPositions = new Set(positionMap.get(personId) || []);
            peopleMap.set(personId, {
              name,
              photo: isInitials ? null : thumb,
              statuses: new Map(),
              attended: new Map(),
              blockedOut: new Map(),
              prepareNotif: new Map(),
              notifSentAt: new Map(),
              statusUpdatedAt: new Map(),
              declineReason: new Map(),
              positions: seedPositions,
            });
          }
          const person = peopleMap.get(personId);
          // Also add plan-level position in case it differs (e.g. training → full)
          const posName = (tm.attributes.team_position_name || "").toLowerCase();
          if (posName) person.positions.add(posName);
          person.statuses.set(colKey, status);
          person.prepareNotif.set(colKey, prepareNotif);
          person.notifSentAt.set(colKey, notifSentAt);
          person.statusUpdatedAt.set(colKey, statusUpdatedAt);
          if (declineReason) person.declineReason.set(colKey, declineReason);
          if (attendances.length > 0) {
            person.attended.set(colKey, didAttend);
          }
        }
      } catch {
        console.log(`  Skipped plan ${plan.id} due to error`);
      }
    }
  }

  // 5. Fetch blockout dates for ALL team members (positionMap), not just rostered ones.
  //    This ensures blockouts are shown even for members not rostered in the current window.
  const blockoutMap = new Map();
  const personIds = positionMap.size > 0 ? [...positionMap.keys()] : [...peopleMap.keys()];
  console.log(`[${slug}] Fetching blockout dates for ${personIds.length} member(s)...`);
  const _blockoutBatch = (ORG.api && ORG.api.blockoutBatchSize)  || 5;
  const _blockoutDelay = (ORG.api && ORG.api.blockoutBatchDelay) || 300;
  for (let i = 0; i < personIds.length; i += _blockoutBatch) {
    if (i > 0) await delay(_blockoutDelay);
    const batch = personIds.slice(i, i + _blockoutBatch);
    await Promise.all(
      batch.map(async (pid) => {
        try {
          // Fetch blockouts directly — starts_at/ends_at are on the Blockout record itself.
          // The blockout_dates sub-resource (individual days) is not needed and is forbidden.
          const { data: blockouts } = await pcoFetchAll(env, `${BASE}/people/${pid}/blockouts?per_page=100`);
          const relevant = blockouts.filter((bo) => {
            const startDay = (bo.attributes.starts_at || "").slice(0, 10);
            const endDay   = (bo.attributes.ends_at   || "").slice(0, 10);
            return endDay >= afterParam && startDay <= beforeParam;
          });
          if (relevant.length > 0) {
            blockoutMap.set(pid, relevant.map((bo) => ({
              starts: bo.attributes.starts_at.slice(0, 10),
              ends:   bo.attributes.ends_at.slice(0, 10),
            })));
          }
        } catch (err) {
          console.log(`  Blockout fetch failed for person ${pid}: ${err.message}`);
        }
      })
    );
  }
  console.log(`[${slug}] Blockout dates found for ${blockoutMap.size} member(s)`);

  // Cross-reference blockout ranges with plan dates.
  // Ranges are stored as plain YYYY-MM-DD strings for timezone-safe comparison.
  for (const [personId, person] of peopleMap) {
    const ranges = blockoutMap.get(personId);
    if (!ranges || ranges.length === 0) continue;
    for (const col of allColumns) {
      const planDay = col.sortDate.slice(0, 10);
      const isBlocked = ranges.some((r) => planDay >= r.starts && planDay <= r.ends);
      if (isBlocked) {
        person.blockedOut.set(col.key, true);
      }
    }
  }

  // 6. Fetch member details from People API + login dates from Services API in parallel.
  //    People API provides name, gender, avatar, birthdate, anniversary, marital_status.
  //    Services API provides logged_in_at (last login to PCO Services).
  //    Both use the same person IDs and batch size, so we fire them concurrently.
  const genderMap      = new Map(); // personId -> "M" | "F" | null
  const birthdateMap   = new Map(); // personId -> "YYYY-MM-DD" | null
  const anniversaryMap = new Map(); // personId -> "YYYY-MM-DD" | null
  const maritalMap     = new Map(); // personId -> string | null
  const loginMap       = new Map(); // personId -> ISO datetime string | null
  const avatarMap = new Map([...peopleMap.entries()].map(([id, p]) => [id, p.photo || null]));
  const PEOPLE_BASE = "https://api.planningcenteronline.com/people/v2";
  // Use all positionMap IDs (full team) — superset of peopleMap IDs
  const allPersonIds = positionMap.size > 0 ? [...positionMap.keys()] : [...peopleMap.keys()];
  console.log(`[${slug}] Fetching member details + login dates for ${allPersonIds.length} member(s)...`);
  const _peopleBatch = (ORG.api && ORG.api.peopleBatchSize) || 100;
  for (let i = 0; i < allPersonIds.length; i += _peopleBatch) {
    const batch = allPersonIds.slice(i, i + _peopleBatch);
    const batchIds = batch.join(",");

    // Fire People API + Services API calls for this batch concurrently
    const [peopleResult, loginResult] = await Promise.allSettled([
      pcoFetchAll(env, `${PEOPLE_BASE}/people?where[id]=${batchIds}&fields[Person]=first_name,last_name,gender,avatar,birthdate,anniversary,marital_status&per_page=${_peopleBatch}`),
      pcoFetchAll(env, `${BASE}/people?where[id]=${batchIds}&fields[Person]=logged_in_at&per_page=${_peopleBatch}`),
    ]);

    // Process People API results
    if (peopleResult.status === 'fulfilled') {
      for (const p of peopleResult.value.data) {
        const raw = p.attributes.gender;
        const g = raw === "Male" || raw === "M" ? "M"
                : raw === "Female" || raw === "F" ? "F"
                : null;
        genderMap.set(p.id, g);
        if (p.attributes.birthdate)    birthdateMap.set(p.id, p.attributes.birthdate);
        if (p.attributes.anniversary)  anniversaryMap.set(p.id, p.attributes.anniversary);
        if (p.attributes.marital_status) maritalMap.set(p.id, p.attributes.marital_status);

        // Seed unrostered members into peopleMap with empty maps
        if (!peopleMap.has(p.id)) {
          const firstName = p.attributes.first_name || "";
          const lastName  = p.attributes.last_name  || "";
          const name      = (firstName + " " + lastName).trim() || `Member ${p.id}`;
          const avatar    = p.attributes.avatar || null;
          peopleMap.set(p.id, {
            name,
            photo: avatar,
            statuses:        new Map(),
            attended:        new Map(),
            blockedOut:      new Map(),
            prepareNotif:    new Map(),
            notifSentAt:     new Map(),
            statusUpdatedAt: new Map(),
            positions:       new Set(positionMap.get(p.id) || []),
          });
          avatarMap.set(p.id, avatar);
        } else {
          // Update avatar for rostered members if People API has a better one
          if (!avatarMap.get(p.id) && p.attributes.avatar) {
            avatarMap.set(p.id, p.attributes.avatar);
          }
        }
      }
    } else {
      console.log(`  Could not fetch people data for batch at index ${i}`);
    }

    // Process Services API login results
    if (loginResult.status === 'fulfilled') {
      for (const sp of loginResult.value.data) {
        if (sp.attributes.logged_in_at) loginMap.set(sp.id, sp.attributes.logged_in_at);
      }
    } else {
      console.log(`  Could not fetch Services login data for batch at index ${i}: ${loginResult.reason?.message}`);
    }
  }
  console.log(`[${slug}] peopleMap now has ${peopleMap.size} members (${positionMap.size - peopleMap.size > 0 ? 0 : peopleMap.size - (positionMap.size || peopleMap.size)} unrostered added)`);
  console.log(`[${slug}] loginMap has ${loginMap.size} entries`);

  // Sort columns chronologically
  // Sort: future dates first (ascending), then past dates (descending) — most recent past closest to centre
  const futureCols = allColumns.filter(c => c.sortDate.slice(0, 10) >= _todayLocal).sort((a,b) => new Date(a.sortDate)-new Date(b.sortDate));
  const pastCols   = allColumns.filter(c => c.sortDate.slice(0, 10) <  _todayLocal).sort((a,b) => new Date(b.sortDate)-new Date(a.sortDate));
  allColumns.length = 0;
  allColumns.push(...futureCols, ...pastCols);

  const _duration = ((Date.now() - _startTime) / 1000).toFixed(1);
  console.log(`[${slug}] Total: ${allColumns.length} plan columns, ${peopleMap.size} unique members — ${_apiCallCount} API calls in ${_duration}s`);
  return { columns: allColumns, peopleMap, genderMap, avatarMap, positionMap, birthdateMap, anniversaryMap, maritalMap, loginMap, memberAddedMap, teamConfig, apiCallCount: _apiCallCount, duration: _duration };
}

// --- Rendering helpers ---

function formatDate(dateStr) {
  if (!dateStr) return "?";
  // Slice YYYY-MM-DD directly to avoid timezone conversion through Date constructor
  const [, mm, dd] = dateStr.slice(0, 10).split('-').map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[mm - 1]} ${dd}`;
}

function statusIcon(status) {
  switch (status) {
    case "C":
      return { icon: "&#x2705;", cls: "confirmed" };
    case "D":
      return { icon: "&#x274C;", cls: "declined" };
    case "U":
      return { icon: "&#x23F3;", cls: "unconfirmed" };
    default:
      return { icon: "&mdash;", cls: "unknown" };
  }
}

function statusLabel(status) {
  switch (status) {
    case "C": return "Confirmed";
    case "D": return "Declined";
    case "U": return "Unconfirmed";
    default: return status || "Unknown";
  }
}

function hasThreeConsecutiveDeclines(statuses, blockedOut, columns, threshold = 3) {
  let consecutive = 0;
  let foundStreak = false;
  let streakEndIndex = -1;
  // First pass: find if there was a streak of threshold+ declines
  for (let i = 0; i < statuses.length; i++) {
    const s = statuses[i];
    const isBlocked = blockedOut.get(columns[i].key) === true;
    if (s === "not_scheduled") continue;
    if (s === "D" && !isBlocked) {
      consecutive++;
      if (consecutive >= threshold) {
        foundStreak = true;
        streakEndIndex = i;
      }
    } else {
      consecutive = 0;
    }
  }
  if (!foundStreak) return false;
  // Second pass: check if there's a Confirm (C) after the streak
  // If so, the decline warning should be cleared
  for (let i = streakEndIndex + 1; i < statuses.length; i++) {
    const s = statuses[i];
    if (s === "not_scheduled") continue;
    if (s === "C") return false; // Confirm after streak clears the flag
    if (s === "D") return true; // Another decline after streak, streak still active
  }
  return true;
}

function hasThreeConfirmedNoShow(statuses, attended, columns, threshold = 3) {
  let consecutive = 0;
  for (const col of columns) {
    const status = statuses.get(col.key);
    const att = attended.get(col.key);
    if (!status || status === "not_scheduled") continue;
    if (status === "C" && att === undefined) continue;
    if (status === "C" && att === false) {
      consecutive++;
      if (consecutive >= threshold) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function computeConfirmedPct(statuses, blockedOut) {
  let confirmed = 0, declined = 0;
  for (const [colKey, s] of statuses.entries()) {
    if (s === "C") confirmed++;
    else if (s === "D" && blockedOut.get(colKey) !== true) declined++;
  }
  const total = confirmed + declined;
  if (total === 0) return null;
  return Math.round((confirmed / total) * 100);
}

function computeAttendPct(statuses, attended, columns, todayLocal) {
  let confirmedCount = 0, attendedCount = 0;
  for (const col of columns) {
    if (col.sortDate.slice(0, 10) > todayLocal) continue; // only past services
    const status = statuses.get(col.key);
    if (status === "C") {
      confirmedCount++;
      if (attended.get(col.key) === true) attendedCount++;
    }
  }
  if (confirmedCount === 0) return null;
  return Math.round((attendedCount / confirmedCount) * 100);
}

// --- Position classification --- (rules driven by teamConfig.roles)

function roleTitle(roleDef, training) {
  return roleDef.label + (training ? ' (Training)' : '');
}

function classifyPosition(positions, roleDefs) {
  if (!roleDefs || roleDefs.length === 0) return [];
  const resolved = {};
  for (const pos of positions) {
    for (const rd of roleDefs) {
      const isTraining = rd.trainTerms.some(t => pos.includes(t));
      const isFull = !isTraining && rd.fullTerms.some(t => pos.includes(t));
      if (isFull) resolved[rd.key] = 2;
      else if (isTraining && (resolved[rd.key] || 0) < 2) resolved[rd.key] = 1;
    }
  }
  // Return in the order defined in roleDefs
  return roleDefs
    .filter(rd => rd.key in resolved)
    .map(rd => ({ role: rd.key, training: resolved[rd.key] === 1, def: rd }));
}

// --- Main render ---

// Returns { week: 0|1|2, dayLabel: "Apr 5" } for a YYYY-MM-DD birthday/anniversary this or next week
// week 0 = this week, week 1 = next week (week starts on ORG.weekStartDay)
function upcomingOccasion(dateStr) {
  if (!dateStr) return null;
  // Use org timezone so week boundaries roll over at local midnight
  const _parts = new Date().toLocaleDateString('en-CA', { timeZone: ORG.timezone || 'UTC' }).split('-').map(Number);
  const today = new Date(_parts[0], _parts[1] - 1, _parts[2]);
  // Week start day from config (0=Sun, 1=Mon, …)
  const wsd = ORG.weekStartDay ?? 0;
  const day = today.getDay();
  const offset = (day - wsd + 7) % 7;
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - offset);
  const weekEnd1 = new Date(weekStart); weekEnd1.setDate(weekStart.getDate() + 6);
  const weekStart2 = new Date(weekStart); weekStart2.setDate(weekStart.getDate() + 7);
  const weekEnd2 = new Date(weekStart); weekEnd2.setDate(weekStart.getDate() + 13);

  const [, mm, dd] = dateStr.slice(0, 10).split('-').map(Number);
  const year = today.getFullYear();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const label = months[mm - 1] + " " + dd;

  // Try this year, last year, and next year (handles week crossing year boundary)
  for (const y of [year, year - 1, year + 1]) {
    const occ = new Date(y, mm - 1, dd);
    const sortKey = occ.getMonth() * 100 + occ.getDate();
    if (occ >= weekStart && occ <= weekEnd1) return { week: 0, label, sortKey };
    if (occ >= weekStart2 && occ <= weekEnd2) return { week: 1, label, sortKey };
  }
  return null;
}

function renderHTML(data, deviceType = 'desktop') {
  const { columns: rawColumns, peopleMap, genderMap = new Map(), avatarMap = new Map(), positionMap = new Map(),
           birthdateMap = new Map(), anniversaryMap = new Map(), maritalMap = new Map(),
           loginMap = new Map(), memberAddedMap = new Map(), teamConfig = {}, apiCallCount = 0, duration = '?',
           userEmail = null } = data;
  const isMobile = deviceType === 'mobile' || deviceType === 'tablet';
  const teamLabel       = teamConfig.label || "Team";
  const teamIcon        = teamConfig.icon  || "🎵";
  const roleDefs        = teamConfig.roles || [];

  // Chronological order: past ascending (oldest left) then future ascending (next roster rightmost of future = focus point)
  const _renderNowStr = localDateStr(new Date());
  const columns = [
    ...rawColumns.filter(c => c.sortDate.slice(0, 10) <  _renderNowStr).sort((a, b) => a.sortDate < b.sortDate ? -1 : 1),
    ...rawColumns.filter(c => c.sortDate.slice(0, 10) >= _renderNowStr).sort((a, b) => a.sortDate < b.sortDate ? -1 : 1),
  ];
  const trackAttendance = teamConfig.trackAttendance !== false; // default true
  // Team-level thresholds override org-wide defaults from config.js
  const teamThresholds   = teamConfig.thresholds || {};
  const orgThresholds    = ORG.thresholds || {};
  const declineThreshold = teamThresholds.consecutiveDeclines ?? orgThresholds.consecutiveDeclines ?? 3;
  const noShowThreshold  = teamThresholds.confirmedNoShows    ?? orgThresholds.confirmedNoShows    ?? 3;

  if (columns.length === 0) {
    return `<!DOCTYPE html><html><head><title>${ORG.name} — ${teamLabel}</title></head>
    <body style="font-family:sans-serif;padding:2rem;"><h1>No Data Found</h1>
    <p>No scheduling data found for ${teamLabel}.</p></body></html>`;
  }

  // Sort people alphabetically — filter to permanent team members only (positionMap).
  // Guests rostered on individual plans appear in peopleMap but not positionMap.
  const people = [...peopleMap.entries()]
    .filter(([id]) => positionMap.size === 0 || positionMap.has(id))
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  // --- Exec summary ---
  const now = new Date();
  const _todayLocal = localDateStr(now);
  const confirmedPctValues = [];
  const attendPctValues = [];
  for (const [, personData] of people) {
    let c = 0, d = 0;
    for (const [colKey, s] of personData.statuses.entries()) {
      if (s === "C") c++;
      else if (s === "D" && personData.blockedOut.get(colKey) !== true) d++;
    }
    const t = c + d;
    if (t > 0) confirmedPctValues.push(Math.round((c / t) * 100));
    const ap = computeAttendPct(personData.statuses, personData.attended, columns, _todayLocal);
    if (ap !== null) attendPctValues.push(ap);
  }
  const avgConfirmedPct = confirmedPctValues.length > 0
    ? Math.round(confirmedPctValues.reduce((a, b) => a + b, 0) / confirmedPctValues.length)
    : 0;
  const avgAttendPct = attendPctValues.length > 0
    ? Math.round(attendPctValues.reduce((a, b) => a + b, 0) / attendPctValues.length)
    : 0;

  // --- Attendance line graph data (past dates only) ---
  const pastColumns = columns.filter((col) => col.sortDate.slice(0, 10) <= _todayLocal);
  const graphData = pastColumns.map((col) => {
    let confirmed = 0, attended = 0;
    for (const [, pd] of people) {
      const status = pd.statuses.get(col.key);
      if (status === "C") {
        confirmed++;
        if (pd.attended.get(col.key) === true) attended++;
      }
    }
    const pct = confirmed > 0 ? Math.round((attended / confirmed) * 100) : null;
    const dateOnly = col.sortDate ? formatDate(col.sortDate) : "";
    return { label: dateOnly, pct, attended, confirmed };
  }).filter((d) => d.pct !== null);

  let chartHTML = "";
  if (graphData.length >= 2) {
    const W = 500, H = 200, PAD_L = 35, PAD_R = 20, PAD_T = 20, PAD_B = 40;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const rawMax = Math.max(...graphData.map((d) => d.attended));
    const yStep = rawMax <= 10 ? 2 : rawMax <= 30 ? 5 : 10;
    const maxY = Math.ceil(rawMax / yStep) * yStep || yStep;
    const stepCount = graphData.length;
    const xStep = plotW / (stepCount - 1);

    const points = graphData.map((d, i) => ({
      x: PAD_L + i * xStep,
      y: PAD_T + plotH - (d.attended / maxY) * plotH,
      pct: d.pct,
      label: d.label,
      attended: d.attended,
      confirmed: d.confirmed,
    }));

    const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");

    // Y-axis gridlines and labels
    let yGrid = "";
    for (let v = 0; v <= maxY; v += yStep) {
      const y = PAD_T + plotH - (v / maxY) * plotH;
      yGrid += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="rgba(148,163,184,0.2)" stroke-dasharray="4"/>`;
      yGrid += `<text x="${PAD_L - 8}" y="${y + 4}" text-anchor="end" fill="#94a3b8" font-size="11">${v}</text>`;
    }

    // X-axis labels
    let xLabels = "";
    for (const p of points) {
      xLabels += `<text x="${p.x}" y="${H - 6}" text-anchor="middle" fill="#94a3b8" font-size="10">${escapeHtml(p.label)}</text>`;
    }

    // Data points and tooltips
    let dots = "";
    for (const p of points) {
      dots += `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#3b82f6" stroke="#1e293b" stroke-width="1.5">
        <title>${p.label}: ${p.attended} attended (${p.pct}% of ${p.confirmed} confirmed)</title>
      </circle>`;
    }

    // Average attendance line
    const avgAttended = graphData.reduce((sum, d) => sum + d.attended, 0) / graphData.length;
    const avgY = (PAD_T + plotH - (avgAttended / maxY) * plotH).toFixed(2);
    const avgLine = `<line x1="${PAD_L}" y1="${avgY}" x2="${W - PAD_R}" y2="${avgY}"
      stroke="#f97316" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.85">
      <title>Average attendance: ${avgAttended.toFixed(1)} members per service</title>
    </line>
    <text x="${W - PAD_R + 2}" y="${parseFloat(avgY) + 4}" fill="#f97316" font-size="10" text-anchor="start">avg ${avgAttended.toFixed(1)}
      <title>Average attendance: ${avgAttended.toFixed(1)} members per service</title>
    </text>`;

    chartHTML = `
    <div class="chart-container">
      <div class="chart-title">Attendance by Service Date</div>
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg">
        ${yGrid}
        ${avgLine}
        <polyline points="${polyline}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${xLabels}
        ${dots}
      </svg>
    </div>`;
  }



  // Gender breakdown — only count people who appear in peopleMap (have been rostered
  // and have retrievable data). positionMap may include people the API can't access.
  let femaleCount = 0, maleCount = 0, unknownCount = 0;
  for (const [personId] of people) {
    const g = genderMap.get(personId);
    if (g === "F") femaleCount++;
    else if (g === "M") maleCount++;
    else unknownCount++;
  }
  // Use positionMap.size for full team count — includes members not rostered in the current window
  const totalMembers = positionMap.size > 0 ? positionMap.size : people.length;

  // --- Marital status breakdown ---
  const maritalCounts = {};
  for (const [personId] of people) {
    const ms = maritalMap.get(personId) || "Unknown";
    maritalCounts[ms] = (maritalCounts[ms] || 0) + 1;
  }
  // Marital status pie chart
  const maritalColors = { Married:"#6d28d9", Single:"#0ea5e9", Engaged:"#f97316", Widowed:"#94a3b8", Divorced:"#ef4444", Separated:"#fbbf24", Unknown:"#334155" };
  let maritalPieHTML = "";
  const maritalTotal = Object.values(maritalCounts).reduce((a,b) => a+b, 0);
  const maritalEntries = Object.entries(maritalCounts).filter(([,c]) => c > 0).sort((a,b) => b[1]-a[1]);
  const knownMaritalCount = maritalEntries.filter(([k]) => k !== "Unknown").reduce((s,[,c]) => s+c, 0);
  // Only render if at least one member has a known marital status
  if (knownMaritalCount > 0) {
    const toRadM = (n) => n / maritalTotal * 2 * Math.PI;
    function pieSliceM(startAngle, sweepAngle, r, cx, cy) {
      if (sweepAngle >= 2 * Math.PI) sweepAngle = 2 * Math.PI - 0.0001;
      const x1 = cx + r * Math.sin(startAngle), y1 = cy - r * Math.cos(startAngle);
      const x2 = cx + r * Math.sin(startAngle + sweepAngle), y2 = cy - r * Math.cos(startAngle + sweepAngle);
      return `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${sweepAngle > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    }
    let mAngle = 0;
    const allEntries = maritalEntries;
    const mSlices = allEntries.map(([label, count]) => {
      const sweep = toRadM(count);
      const path = pieSliceM(mAngle, sweep, 55, 70, 70);
      mAngle += sweep;
      return `<path d="${path}" fill="${maritalColors[label] || '#64748b'}" data-marital="${escapeHtml(label)}" class="pie-slice-m" onclick="toggleMaritalFilter('${escapeHtml(label)}')" style="cursor:pointer"><title>${escapeHtml(label)}: ${count}</title></path>`;
    }).join('');
    const legend = allEntries.map(([label, count]) =>
      `<div class="gender-legend-item" onclick="toggleMaritalFilter('${escapeHtml(label)}')" style="cursor:pointer;user-select:none">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${maritalColors[label] || '#64748b'};margin-right:6px;vertical-align:middle;"></span>
        <span style="font-size:0.8rem;">${escapeHtml(label)}: ${count}</span>
      </div>`
    ).join('');
    maritalPieHTML = `
    <div class="chart-container" style="display:flex;align-items:center;gap:1rem;padding:0.75rem;flex:0 0 auto;">
      <svg viewBox="0 0 140 140" width="150" height="150" style="flex-shrink:0;cursor:pointer">
        ${mSlices}
      </svg>
      <div style="font-size:0.8rem;line-height:2;">${legend}</div>
    </div>`;
  }

  // --- Age range bar chart ---
  const AGE_BUCKETS = [
    { label:"<20",  min:0,  max:19  },
    { label:"20–24",min:20, max:24  },
    { label:"25–29",min:25, max:29  },
    { label:"30–34",min:30, max:34  },
    { label:"35–39",min:35, max:39  },
    { label:"40–44",min:40, max:44  },
    { label:"45–49",min:45, max:49  },
    { label:"50–54",min:50, max:54  },
    { label:"55+",  min:55, max:999 },
  ];
  const ageCounts = AGE_BUCKETS.map(b => ({ ...b, count: 0 }));
  let knownAgeCount = 0;
  const today = new Date();
  for (const [personId] of people) {
    const bd = birthdateMap.get(personId);
    if (!bd) continue;
    const [y, m, d] = bd.slice(0,10).split('-').map(Number);
    let age = today.getFullYear() - y;
    if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
    const bucket = ageCounts.find(b => age >= b.min && age <= b.max);
    if (bucket) { bucket.count++; knownAgeCount++; }
  }
  const unknownAgeCount = people.length - knownAgeCount;
  // Add unknown bucket at the end
  const allAgeCounts = [
    ...ageCounts,
    { label: "Unknown", min: -1, max: -1, count: unknownAgeCount, unknown: true },
  ];

  let ageBarHTML = "";
  if (knownAgeCount > 0 || unknownAgeCount > 0) {
    const maxCount = Math.max(...allAgeCounts.map(b => b.count), 1);
    const W = 340, H = 175, PAD_L = 28, PAD_R = 8, PAD_T = 15, PAD_B = 35;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const bw = Math.floor(plotW / allAgeCounts.length);
    const gap = 3;
    const bars = allAgeCounts.map((b, i) => {
      const bh = b.count > 0 ? Math.max(4, Math.round((b.count / maxCount) * plotH)) : 0;
      const x = PAD_L + i * bw + gap;
      const y = PAD_T + plotH - bh;
      const labelX = PAD_L + i * bw + bw / 2;
      const clickable = b.count > 0;
      const cursor = clickable ? 'cursor:pointer' : '';
      const bucketLabel = escapeHtml(b.label);
      return (bh > 0 ? `<rect x="${x}" y="${y}" width="${bw - gap * 2}" height="${bh}"
          fill="${b.unknown ? '#ef4444' : '#3b82f6'}" rx="2" opacity="0.85" class="age-bar" data-bucket="${bucketLabel}"
          ${clickable ? 'onclick="toggleAgeFilter(\'' + bucketLabel + '\')" style="' + cursor + '"' : ''}
          ><title>${bucketLabel}: ${b.count} — click to filter</title></rect>` : '')
        + (b.count > 0 ? `<text x="${labelX}" y="${y - 3}" text-anchor="middle" fill="#94a3b8" font-size="9">${b.count}</text>` : '')
        + `<text x="${labelX}" y="${H - 6}" text-anchor="middle" fill="#94a3b8" font-size="8"
            ${clickable ? 'class="age-bar-label" data-bucket="' + bucketLabel + '" onclick="toggleAgeFilter(\'' + bucketLabel + '\')" style="' + cursor + '"' : ''}
            >${bucketLabel}</text>`;
    }).join('');
    ageBarHTML = `
    <div class="chart-container" style="padding:0.75rem;flex:0 0 auto;display:flex;flex-direction:column;justify-content:center;">
      <div class="chart-title">Age Distribution</div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-height:150px;display:block" id="age-bar-svg">
        ${bars}
      </svg>
    </div>`;
  }

  // --- Last Login recency chart ---
  const LOGIN_BUCKETS = (ORG.loginBuckets || [
    { label: "<7d", min: 0, max: 7 }, { label: "8\u201314d", min: 8, max: 14 },
    { label: "15\u201321d", min: 15, max: 21 }, { label: ">21d", min: 22, max: Infinity },
    { label: "Never", min: -1, max: -1 },
  ]);
  const loginCounts = LOGIN_BUCKETS.map(b => ({ ...b, count: 0 }));
  const nowMs = Date.now();
  for (const [personId] of people) {
    const lastLogin = loginMap.get(personId);
    if (!lastLogin) {
      loginCounts[4].count++;
    } else {
      const daysAgo = Math.floor((nowMs - new Date(lastLogin).getTime()) / 86400000);
      if (daysAgo <= 7)       loginCounts[0].count++;
      else if (daysAgo <= 14) loginCounts[1].count++;
      else if (daysAgo <= 21) loginCounts[2].count++;
      else                    loginCounts[3].count++;
    }
  }

  let loginBarHTML = "";
  if (people.length > 0) {
    const lMax = Math.max(...loginCounts.map(b => b.count), 1);
    const LW = 260, LH = 175, LP_L = 10, LP_R = 8, LP_T = 15, LP_B = 35;
    const lPlotW = LW - LP_L - LP_R, lPlotH = LH - LP_T - LP_B;
    const lbw = Math.floor(lPlotW / loginCounts.length);
    const lGap = 3;
    const lBars = loginCounts.map((b, i) => {
      const bh = b.count > 0 ? Math.max(4, Math.round((b.count / lMax) * lPlotH)) : 0;
      const x = LP_L + i * lbw + lGap;
      const y = LP_T + lPlotH - bh;
      const labelX = LP_L + i * lbw + lbw / 2;
      const fill = b.min === -1 ? '#ef4444' : b.max <= 7 ? '#22c55e' : b.max <= 14 ? '#3b82f6' : b.max <= 21 ? '#f59e0b' : '#f97316'; // >21d = orange, Never = red
      const clickable = b.count > 0;
      const cursor = clickable ? 'cursor:pointer' : '';
      const bLabel = escapeHtml(b.label);
      return (bh > 0 ? `<rect x="${x}" y="${y}" width="${lbw - lGap * 2}" height="${bh}"
          fill="${fill}" rx="2" opacity="0.85" class="login-bar" data-bucket="${bLabel}"
          ${clickable ? 'onclick="toggleLoginFilter(\'' + bLabel + '\')" style="' + cursor + '"' : ''}
          ><title>${bLabel}: ${b.count} — click to filter</title></rect>` : '')
        + (b.count > 0 ? `<text x="${labelX}" y="${y - 3}" text-anchor="middle" fill="#94a3b8" font-size="9">${b.count}</text>` : '')
        + `<text x="${labelX}" y="${LH - 6}" text-anchor="middle" fill="#94a3b8" font-size="8"
            ${clickable ? 'class="login-bar-label" data-bucket="' + bLabel + '" onclick="toggleLoginFilter(\'' + bLabel + '\')" style="' + cursor + '"' : ''}
            >${bLabel}</text>`;
    }).join('');
    loginBarHTML = `
    <div class="chart-container" style="padding:0.75rem;flex:0 0 auto;display:flex;flex-direction:column;justify-content:center;">
      <div class="chart-title">Last Login</div>
      <svg viewBox="0 0 ${LW} ${LH}" style="width:100%;max-height:150px;display:block">
        ${lBars}
      </svg>
    </div>`;
  }

  // --- Upcoming birthdays & anniversaries ---
  const occasions = { thisWeek: [], nextWeek: [] };
  for (const [personId, pd] of people) {
    const name = pd.name;
    const bd = birthdateMap.get(personId);
    const ann = anniversaryMap.get(personId);
    if (bd) {
      const occ = upcomingOccasion(bd);
      if (occ) occasions[occ.week === 0 ? 'thisWeek' : 'nextWeek'].push({ name, type: '🎂', label: 'Birthday', date: occ.label, sortKey: occ.sortKey });
    }
    if (ann) {
      const occ = upcomingOccasion(ann);
      if (occ) occasions[occ.week === 0 ? 'thisWeek' : 'nextWeek'].push({ name, type: '💍', label: 'Anniversary', date: occ.label, sortKey: occ.sortKey });
    }
  }
  let occasionsHTML = "";
  occasions.thisWeek.sort((a,b) => a.sortKey - b.sortKey);
  occasions.nextWeek.sort((a,b) => a.sortKey - b.sortKey);
  if (occasions.thisWeek.length > 0 || occasions.nextWeek.length > 0) {
    const renderOccasions = (list) => list.length === 0 ? '<span style="color:var(--text-muted);font-size:0.8rem;">None</span>'
      : list.map(o => `<div style="font-size:0.85rem;padding:0.2rem 0;">${o.type} <strong>${escapeHtml(o.name)}</strong> — ${o.label} <span style="color:var(--text-muted)">(${o.date})</span></div>`).join('');
    occasionsHTML = `
    <div class="panel upcoming-panel" style="margin-bottom:1rem;">
      <div class="panel-title">🎉 Upcoming Birthdays &amp; Anniversaries</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:0.5rem;">
        <div>
          <div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem;">This Week</div>
          ${renderOccasions(occasions.thisWeek)}
        </div>
        <div>
          <div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.4rem;">Next Week</div>
          ${renderOccasions(occasions.nextWeek)}
        </div>
      </div>
    </div>`;
  }

  // --- Response time distribution ---
  // For past plans: days between notification_sent_at and status_updated_at
  // Buckets: same day (0), 1 day, 2 days, 3-7 days, 8+ days
  const rtBuckets = { same: 0, one: 0, two: 0, week: 0, more: 0 };
  let rtTotal = 0;
  let rtSumDays = 0;
  for (const [, pd] of people) {
    for (const col of columns) {
      const sent = pd.notifSentAt ? pd.notifSentAt.get(col.key) : null;
      const updated = pd.statusUpdatedAt ? pd.statusUpdatedAt.get(col.key) : null;
      const status = pd.statuses.get(col.key);
      // Only count past plans where notification was sent and person responded
      if (!sent || !updated || !status || status === "U") continue;
      const diffMs = new Date(updated) - new Date(sent);
      if (diffMs < 0) continue; // updated before sent — skip anomalies
      const days = diffMs / (1000 * 60 * 60 * 24);
      rtSumDays += days;
      rtTotal++;
      if (days < 1) rtBuckets.same++;
      else if (days < 2) rtBuckets.one++;
      else if (days < 3) rtBuckets.two++;
      else if (days <= 7) rtBuckets.week++;
      else rtBuckets.more++;
    }
  }
  const avgResponseDays = rtTotal > 0 ? (rtSumDays / rtTotal) : null;
  const avgResponseStr = avgResponseDays === null ? "N/A"
    : avgResponseDays < 1 ? "< 1 day"
    : `${avgResponseDays.toFixed(1)} days`;

  // Build response time bar chart
  let rtHTML = "";
  if (rtTotal > 0) {
    const rtBars = [
      { label: "Same day", count: rtBuckets.same, cls: "rt-same" },
      { label: "1 day",    count: rtBuckets.one,  cls: "rt-one" },
      { label: "2 days",   count: rtBuckets.two,  cls: "rt-two" },
      { label: "3–7 days", count: rtBuckets.week, cls: "rt-week" },
      { label: "8+ days",  count: rtBuckets.more, cls: "rt-more" },
    ];
    const maxCount = Math.max(...rtBars.map(b => b.count), 1);
    const bars = rtBars.map(b => {
      const pct = Math.round((b.count / maxCount) * 100);
      const labelPct = Math.round((b.count / rtTotal) * 100);
      return `<div class="rt-row">
        <span class="rt-label">${b.label}</span>
        <div class="rt-bar-wrap"><div class="rt-bar ${b.cls}" style="width:${pct}%"></div></div>
        <span class="rt-count">${b.count} <span class="rt-pct">(${labelPct}%)</span></span>
      </div>`;
    }).join("");
    rtHTML = `
    <div class="panel rt-panel">
      <div class="panel-title">&#9201; Response Time Distribution <span class="rt-avg">avg ${avgResponseStr} across ${rtTotal} responses</span></div>
      ${bars}
    </div>`;
  }

  // --- Upcoming service headcount ---
  // Show next N upcoming service dates (count from config), one row per service per date
  const futureColumns = columns.filter(col => col.sortDate.slice(0, 10) >= _todayLocal);
  let upcomingHTML = "";
  if (futureColumns.length > 0) {
    // Collect up to 4 distinct upcoming dates
    const seenDates = [];
    for (const col of futureColumns) {
      const d = col.sortDate.split("T")[0];
      if (!seenDates.includes(d)) seenDates.push(d);
      if (seenDates.length >= ((ORG.upcomingDatesCount) || 4)) break;
    }

    const serviceRows = seenDates.map(date => {
      const dateCols = futureColumns.filter(col => col.sortDate.startsWith(date));
      const dateLabel = formatDate(dateCols[0].sortDate);

      return dateCols.map(col => {
        let confirmed = 0, declined = 0, unconfirmed = 0, notifPending = 0;

        for (const [, pd] of people) {
          const status = pd.statuses.get(col.key);
          const hasPrepared = pd.prepareNotif.get(col.key) === true;
          const hasSent = pd.notifSentAt ? pd.notifSentAt.get(col.key) != null : false;
          const isNotifiedUnconfirmed = hasPrepared && !hasSent && status === "U";
          if (isNotifiedUnconfirmed) notifPending++;
          else if (status === "C") confirmed++;
          else if (status === "D") declined++;
          else if (status === "U") unconfirmed++;
        }
        const total = confirmed + declined + unconfirmed + notifPending;
        const pct = total > 0 ? Math.round((confirmed / total) * 100) : 0;
        const notifHTML = notifPending > 0
          ? `<span class="upcoming-sep">·</span><span class="upcoming-notif">&#x2709;&#xFE0F; ${notifPending} unsent</span>`
          : "";
        return `<div class="upcoming-row">
          <span class="upcoming-date">${escapeHtml(dateLabel)}</span>
          <span class="upcoming-time">${escapeHtml(col.timeLabel)}</span>
          <span class="upcoming-sep">·</span>
          <span class="upcoming-confirmed">${confirmed} confirmed</span>
          <span class="upcoming-sep">·</span>
          <span class="upcoming-unconfirmed">${unconfirmed} pending</span>
          <span class="upcoming-sep">·</span>
          <span class="upcoming-declined">${declined} declined</span>
          ${notifHTML}
          <span class="upcoming-pct">${pct}%</span>
        </div>`;
      }).join("");
    }).join("");

    upcomingHTML = `
    <div class="panel upcoming-panel">
      <div class="panel-title">&#128197; Upcoming Services</div>
      ${serviceRows}
    </div>`;
  }



  // --- Gender pie chart ---
  let genderPieHTML = "";
  if (femaleCount + maleCount > 0) {
    const total = femaleCount + maleCount + unknownCount;
    // SVG pie: cx=cy=70, r=55. Angles in radians.
    const toRad = (pct) => pct / total * 2 * Math.PI;
    function pieSlice(startAngle, sweepAngle, r, cx, cy) {
      if (sweepAngle >= 2 * Math.PI) sweepAngle = 2 * Math.PI - 0.0001;
      const x1 = cx + r * Math.sin(startAngle);
      const y1 = cy - r * Math.cos(startAngle);
      const x2 = cx + r * Math.sin(startAngle + sweepAngle);
      const y2 = cy - r * Math.cos(startAngle + sweepAngle);
      const large = sweepAngle > Math.PI ? 1 : 0;
      return `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    }
    const cx = 70, cy = 70, r = 55;
    const fAngle = toRad(femaleCount);
    const mAngle = toRad(maleCount);
    const uAngle = toRad(unknownCount);
    // Female slice first (pink), then male (blue), then unknown (grey)
    const fPath = pieSlice(0, fAngle, r, cx, cy);
    const mPath = pieSlice(fAngle, mAngle, r, cx, cy);
    const uPath = unknownCount > 0 ? pieSlice(fAngle + mAngle, uAngle, r, cx, cy) : '';

    genderPieHTML = `
    <div class="chart-container" style="display:flex;align-items:center;gap:1rem;padding:0.75rem;flex:0 0 auto;">
      <div class="chart-title">Gender</div>
      <svg viewBox="0 0 140 140" width="150" height="150" style="flex-shrink:0;cursor:pointer" id="gender-pie">
        <path d="${fPath}" fill="#f9a8d4" data-gender="F" class="pie-slice" onclick="toggleGenderFilter('F')" style="cursor:pointer"><title>Filter: Female (${femaleCount})</title></path>
        <path d="${mPath}" fill="#93c5fd" data-gender="M" class="pie-slice" onclick="toggleGenderFilter('M')" style="cursor:pointer"><title>Filter: Male (${maleCount})</title></path>
        ${uPath ? `<path d="${uPath}" fill="#334155" data-gender="U" class="pie-slice" onclick="toggleGenderFilter('U')" style="cursor:pointer"><title>Filter: Unknown (${unknownCount})</title></path>` : ''}
      </svg>
      <div style="font-size:0.8rem;line-height:2;">
        <div class="gender-legend-item" onclick="toggleGenderFilter('F')" style="cursor:pointer;user-select:none" title="Filter female members"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f9a8d4;margin-right:6px;vertical-align:middle;"></span><span class="gender-f">${femaleCount} Female</span></div>
        <div class="gender-legend-item" onclick="toggleGenderFilter('M')" style="cursor:pointer;user-select:none" title="Filter male members"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#93c5fd;margin-right:6px;vertical-align:middle;"></span><span class="gender-m">${maleCount} Male</span></div>
        ${unknownCount > 0 ? `<div class="gender-legend-item" onclick="toggleGenderFilter('U')" style="cursor:pointer;user-select:none" title="Filter unknown gender"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#334155;margin-right:6px;vertical-align:middle;"></span><span class="gender-unknown">${unknownCount} Unknown</span></div>` : ''}
      </div>
    </div>`;
  }

  const summaryHTML = `
    <div class="summary-grid">
      <div class="summary-card">
        <div class="summary-value">${totalMembers}</div>
        <div class="summary-label">${teamLabel} Members</div>
      </div>
      <div class="summary-card">
        <div class="summary-value">${avgConfirmedPct}%</div>
        <div class="summary-label">Avg Confirmed Rate</div>
      </div>
      ${trackAttendance ? `<div class="summary-card">
        <div class="summary-value">${avgAttendPct}%</div>
        <div class="summary-label">Avg Attendance Rate</div>
      </div>` : ''}
      <div class="summary-card">
        <div class="summary-value">${avgResponseStr}</div>
        <div class="summary-label">Avg Roster Response</div>
      </div>
    </div>
    ${occasionsHTML}
    ${upcomingHTML}
    ${rtHTML}
    ${trackAttendance ? chartHTML : ''}
    <div class="charts-row">
      ${genderPieHTML}
      ${ageBarHTML}
      ${maritalPieHTML}
      ${loginBarHTML}
    </div>
  `;

  // --- Table header ---
  // Each th gets data-col=N (0-based) for JS sort; sort indicators are injected by JS
  const attendColOffset = trackAttendance ? 1 : 0;
  let nextRosterColIndex = -1;
  let headerCells = `<th class="sticky-col name-col sortable" data-col="0">Name<span class="sort-icon"></span></th><th class="pct-col sortable" data-col="1">Confirmed&nbsp;%<span class="sort-icon"></span></th>`
    + (trackAttendance ? `<th class="pct-col sortable" data-col="2">Attend&nbsp;%<span class="sort-icon"></span></th>` : '')
    + `<th class="pct-col sortable" data-col="${2 + attendColOffset}">Resp<span class="sort-icon"></span></th>`;
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    const isPast = col.sortDate.slice(0, 10) < _todayLocal;
    const datePart = escapeHtml(formatDate(col.sortDate));
    const timePart = escapeHtml(col.timeLabel);
    const isNextRoster = !isPast && (ci === 0 || columns[ci - 1].sortDate.slice(0, 10) < _todayLocal);
    if (isNextRoster) nextRosterColIndex = ci + 3 + attendColOffset;
    headerCells += `<th class="date-col ${isPast ? "past" : "future"} sortable${isNextRoster ? ' next-roster-col' : ''}" data-col="${ci + 3 + attendColOffset}" ${isNextRoster ? 'id="next-roster-col"' : ''}><span class="date-date">${datePart}</span><span class="date-time">${timePart}<span class="sort-icon"></span></span></th>`;
  }

  // --- Table rows ---
  let rows = "";
  for (const [personId, personData] of people) {
    const orderedStatuses = columns.map(
      (col) => personData.statuses.get(col.key) || "not_scheduled"
    );
    const highlightDecline = hasThreeConsecutiveDeclines(orderedStatuses, personData.blockedOut, columns, declineThreshold);
    const highlightNoShow = hasThreeConfirmedNoShow(personData.statuses, personData.attended, columns, noShowThreshold);
    const cPct = computeConfirmedPct(personData.statuses, personData.blockedOut);
    const cPctStr = cPct !== null ? `${cPct}%` : "&mdash;";
    const _pHigh = (ORG.pctThresholds && ORG.pctThresholds.high)   || 70;
    const _pMed  = (ORG.pctThresholds && ORG.pctThresholds.medium) || 40;
    const cPctCls = cPct !== null ? (cPct >= _pHigh ? "pct-high" : cPct >= _pMed ? "pct-mid" : "pct-low") : "";
    const aPct = computeAttendPct(personData.statuses, personData.attended, columns, now);
    const aPctStr = aPct !== null ? `${aPct}%` : "&mdash;";
    const aPctCls = aPct !== null ? (aPct >= _pHigh ? "pct-high" : aPct >= _pMed ? "pct-mid" : "pct-low") : "";

    const nameCls = highlightDecline ? "highlight-name" : (highlightNoShow ? "highlight-noshow-name" : "");
    let badge = "";
    if (highlightDecline) badge = ' <span class="warn-badge">' + declineThreshold + '+ declines</span>';
    else if (highlightNoShow) badge = ' <span class="warn-badge noshow-badge">' + noShowThreshold + '+ no-show</span>';
    // New member badge — added within newMemberDays
    const addedAt = memberAddedMap.get(personId);
    if (addedAt) {
      const addedDate = new Date(addedAt);
      const daysSince = (Date.now() - addedDate) / (1000 * 60 * 60 * 24);
      const newThreshold = ORG.newMemberDays ?? 30;
      if (daysSince < newThreshold) badge += ' <span class="badge new-badge">New</span>';
    }

    const gender = genderMap.get(personId);
    const genderCls = gender === "F" ? " gender-f" : gender === "M" ? " gender-m" : " gender-unknown";
    const avatarUrl = avatarMap.get(personId);
    const avatarImg = avatarUrl
      ? `<span class="member-avatar-wrap"><img src="${escapeHtml(avatarUrl)}" class="member-avatar" alt="" loading="lazy"></span>`
      : `<span class="member-avatar member-avatar-generic" aria-hidden="true"></span>`;
    const sortName = personData.name.toLowerCase();
    const sortCPct = cPct !== null ? cPct : -1;
    const sortAPct = aPct !== null ? aPct : -1;

    // Per-person avg response time
    let rtSum = 0, rtCount = 0;
    for (const col of columns) {
      const sent = personData.notifSentAt ? personData.notifSentAt.get(col.key) : null;
      const updated = personData.statusUpdatedAt ? personData.statusUpdatedAt.get(col.key) : null;
      const st = personData.statuses.get(col.key);
      if (!sent || !updated || !st || st === "U") continue;
      const diff = new Date(updated) - new Date(sent);
      if (diff < 0) continue;
      rtSum += diff / (1000 * 60 * 60 * 24);
      rtCount++;
    }
    const rtAvg = rtCount > 0 ? rtSum / rtCount : null;
    const rtStr = rtAvg === null ? "&mdash;"
      : rtAvg < 1 ? "&lt;1d"
      : `${rtAvg.toFixed(1)}d`;
    // Colour: green <1d, yellow 1-3d, red 3+d (inverse of confirmed rate — lower is better)
    const _rtFast = (ORG.responseTime && ORG.responseTime.fast) || 1;
    const _rtOk   = (ORG.responseTime && ORG.responseTime.ok)   || 3;
    const rtCls = rtAvg === null ? "" : rtAvg < _rtFast ? "pct-high" : rtAvg <= _rtOk ? "pct-mid" : "pct-low";
    const sortRt = rtAvg !== null ? rtAvg : 9999;
    const roles = classifyPosition(personData.positions || new Set(), roleDefs);
    const roleIcons = roles.map(({ role, training, def }) => {
      const bg   = training ? def.trainingColor : def.color;
      const fg   = training ? def.trainingTextColor : (def.textColor || '#fff');
      return `<span class="role-badge" style="background:${bg};color:${fg}" title="${roleTitle(def, training)}">${role}</span>`;
    }).join('');
    // Store roles as data attribute for JS position filtering
    const roleKeys = roles.map(r => r.role).join(',');
    const genderKey  = gender === "F" ? "F" : gender === "M" ? "M" : "U";
    const maritalKey = escapeHtml(maritalMap.get(personId) || "Unknown");
    // Compute age bucket for this person
    const _bd = birthdateMap.get(personId);
    let ageBucket = "";
    if (_bd) {
      const [_y,_m,_d] = _bd.slice(0,10).split('-').map(Number);
      let _age = now.getFullYear() - _y;
      if (now.getMonth()+1 < _m || (now.getMonth()+1 === _m && now.getDate() < _d)) _age--;
      ageBucket = _age<20?'<20':_age<25?'20–24':_age<30?'25–29':_age<35?'30–34':_age<40?'35–39':_age<45?'40–44':_age<50?'45–49':_age<55?'50–54':'55+';
    } else {
      ageBucket = 'Unknown';
    }
    // Compute login bucket for this person
    const _lastLogin = loginMap.get(personId);
    let loginBucket = 'Never';
    if (_lastLogin) {
      const _daysAgo = Math.floor((nowMs - new Date(_lastLogin).getTime()) / 86400000);
      loginBucket = _daysAgo <= 7 ? '<7d' : _daysAgo <= 14 ? '8\u201314d' : _daysAgo <= 21 ? '15\u201321d' : '>21d';
    }
    let cells = `<td class="sticky-col name-col ${nameCls}${genderCls}" data-sort="${escapeHtml(sortName)}" data-roles="${roleKeys}" data-gender="${genderKey}" data-marital="${maritalKey}" data-age="${ageBucket}" data-login="${escapeHtml(loginBucket)}">${avatarImg}${escapeHtml(personData.name)}${badge}${roleIcons ? ` <span class="role-icons">${roleIcons}</span>` : ''}</td>`;
    cells += `<td class="pct-col ${cPctCls}" data-sort="${sortCPct}">${cPctStr}</td>`;
    if (trackAttendance) cells += `<td class="pct-col ${aPctCls}" data-sort="${sortAPct}">${aPctStr}</td>`;
    cells += `<td class="pct-col ${rtCls}" data-sort="${sortRt}">${rtStr}</td>`;

    for (let ci2 = 0; ci2 < columns.length; ci2++) {
      const col = columns[ci2];
      const status = personData.statuses.get(col.key);
      const att = personData.attended.get(col.key);
      const isBlocked = personData.blockedOut.get(col.key) === true;
      const isPast = col.sortDate.slice(0, 10) < _todayLocal;
      const isNextRosterTd = (ci2 + 3 + attendColOffset) === nextRosterColIndex;
      const blockCls = isBlocked ? " blockout" : "";
      const prepareNotif = personData.prepareNotif.get(col.key) === true;
      const notifSentAt = personData.notifSentAt ? personData.notifSentAt.get(col.key) : null;

      // notifSentAt already captured above; hasSent = notification was actually delivered
      const hasSent = notifSentAt != null;
      // isUnsentFuture: rostered future plan where notification hasn't been sent yet
      // → show dot + ✉️ instead of ⏳ (person hasn't been notified yet)
      const isUnsentFuture = !isPast && prepareNotif && status === "U";
      // isNotifiedFuture: rostered future plan where notification was sent but no response yet
      // → show ⏳ as normal unconfirmed
      // ✉️ icon: only on future plans where notification is queued (prepareNotif) but not yet sent
      const notifIcon = (!isPast && prepareNotif && !hasSent) ? '<span class="att notif-pending" title="Notification prepared but not sent">&#x2709;&#xFE0F;</span>' : "";

      const declineReason = personData.declineReason ? personData.declineReason.get(col.key) : null;
      // Blocked + declined: the blockout IS the reason for the decline — show blockout only
      const isBlockedDecline = isBlocked && status === "D";

      const sortVal = status === "C" ? 2 : status === "U" ? 1 : (status === "D" && !isBlockedDecline) ? 0 : -1;
      if (status && !isUnsentFuture && !isBlockedDecline) {
        const { icon, cls } = statusIcon(status);
        let attIcon = "";
        if (trackAttendance && att === true) attIcon = '<span class="att att-yes" title="Attended">&#x1F44D;</span>';
        else if (trackAttendance && att === false && status === "C") attIcon = '<span class="att att-no" title="Did not attend">&#x1F6AB;</span>';

        const noShowCls = (status === "C" && att === false) ? " confirmed-noshow" : "";
        const declineNote = (status === "D" && declineReason) ? ' — "' + declineReason + '"' : '';
        const titleExtra = (att === true ? ' (Attended)' : (att === false && status === "C") ? ' (No-show)' : '')
          + declineNote
          + (isBlocked ? ' [BLOCKED OUT]' : '')
          + (prepareNotif && !hasSent ? ' [NOTIFICATION PENDING]' : '');
        cells += `<td class="status-cell ${cls}${noShowCls}${blockCls} ${isPast ? "past" : "future"}${isNextRosterTd ? ' next-roster-cell' : ''}" data-sort="${sortVal}" title="${escapeHtml(personData.name)} - ${escapeHtml(col.label)}: ${statusLabel(status)}${escapeHtml(titleExtra)}">${icon}${attIcon}${notifIcon}</td>`;
      } else {
        // Not scheduled, unsent future, OR blocked decline — show blockout pattern / dot
        const titleParts = [];
        if (isBlockedDecline) titleParts.push("Blocked out (auto-declined by PCO)");
        else if (isBlocked) titleParts.push("Blocked out");
        else if (isUnsentFuture) titleParts.push("Notification pending");
        else titleParts.push("Not scheduled");
        const dot = isBlocked ? "&#x1F6C7;" : isUnsentFuture ? "" : "&middot;";
        cells += `<td class="status-cell not-scheduled${blockCls} ${isPast ? "past" : "future"}${isNextRosterTd ? ' next-roster-cell' : ''}" data-sort="${sortVal}" title="${titleParts.join(' ')}">${dot}${notifIcon}</td>`;
      }
    }

    const rowCls = highlightDecline ? "highlight-row" : (highlightNoShow ? "highlight-noshow-row" : "");
    rows += `<tr class="${rowCls}">${cells}</tr>\n`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${ORG.name} &mdash; ${teamLabel}</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="icon" type="image/png" href="/favicon.png">

</head>
<body>
  <div class="title-bar">
    <a href="/" class="home-btn" title="All Teams">&#8592; All Teams</a>
    <h1>${teamIcon} ${ORG.name} &mdash; ${teamLabel}</h1>
    <button type="button" id="theme-toggle" title="Toggle light/dark mode">🌙</button>
    <button type="button" id="help-btn" title="Help">?</button>
  </div>
  ${summaryHTML}
  <div class="team-section">
    <h2>All ${teamLabel} Rosters</h2>
    <div class="filter-bar">
      <input type="text" id="name-filter" placeholder="Filter by member name…" autocomplete="off" spellcheck="false">
      <button type="button" id="name-filter-clear" aria-label="Clear filter">&#x2715;</button>
    </div>
    <div class="filter-bar filter-bar--toggles">
      <div class="col-toggles">
        <button type="button" class="col-toggle${isMobile ? '' : ' active'}" data-cols="1" title="Toggle Confirmed %">C%</button>
        ${trackAttendance ? '<button type="button" class="col-toggle' + (isMobile ? '' : ' active') + '" data-cols="2" title="Toggle Attendance %">A%</button>' : ''}
        <button type="button" class="col-toggle${isMobile ? '' : ' active'}" data-cols="${2 + attendColOffset}" title="Toggle Response Time">Resp</button>
      </div>
      ${roleDefs.length > 0 ? `<div class="role-filters">
        ${roleDefs.map(rd =>
          '<button type="button" class="role-filter-btn" data-role="' + rd.key + '" title="' + rd.label + 's" style="background-color:' + rd.color + ' !important;color:#fff">' + rd.key + '</button>'
        ).join('')}
      </div>` : ''}
    </div>
    <div class="grid-wrapper">
      <table>
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="legend">
      <span>&#x2705; Confirmed</span>
      <span>&#x274C; Declined</span>
      <span>&#x23F3; Unconfirmed</span>
      <span>&middot; Not Scheduled</span>
      <span class="legend-highlight">&#9632; ${declineThreshold}+ consecutive declines</span>
      <span class="legend-noshow">&#9632; 3+ confirmed no-show</span>
      ${trackAttendance ? '<span>&#x1F44D; Attended</span>' : ''}
      ${trackAttendance ? '<span>&#x1F6AB; No-show</span>' : ''}
      <span>&#x2709;&#xFE0F; Notification pending</span>
      <span style="background:repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(148,163,184,0.3) 3px,rgba(148,163,184,0.3) 5px);padding:0 6px;">Blocked&nbsp;Out</span>
    </div>
  </div>
  <p class="subtitle" style="margin-top:2rem; text-align:center;">
    Last refreshed: ${new Date().toLocaleString(ORG.locale || "en-AU", { timeZone: ORG.timezone || "UTC" })}
    &nbsp;&middot;&nbsp; ${duration}s &nbsp;&middot;&nbsp; ${apiCallCount} API calls
    ${userEmail ? `<br>Generated for ${escapeHtml(userEmail)}` : ''}
  </p>

  <img id="avatar-popup" src="" alt="" aria-hidden="true">
  <div id="help-overlay"></div>
  <div id="help-modal" role="dialog" aria-modal="true" aria-label="Help">
    <div class="help-header">
      <h2>${teamIcon} ${teamLabel} — Help</h2>
      <button type="button" id="help-close" aria-label="Close help">&#x2715;</button>
    </div>
    <div class="help-body">

      <h3>Filtering &amp; Sorting</h3>
      <p>Type in the <strong>Filter by member name</strong> box to instantly narrow rows.${roleDefs.length > 0 ? ' Click the coloured role buttons (<strong>' + roleDefs.map(rd => rd.key).join(' ') + '</strong>) to filter by specialist role — clicking an active button deselects it. Name filter and role filter stack.' : ''}</p>
      <p>Click any <strong>column header</strong> to sort by that column. Click again to reverse the order. A filled ▲/▼ shows the active sort; a hollow △ indicates other sortable columns.</p>
      <p>The <strong>C% A% Resp</strong> pill buttons in the filter bar toggle the Confirmed %, Attendance % and Response Time columns on and off. The current visibility is saved in the URL (e.g. <code>?cols=ca</code>) so you can bookmark or share a specific view.</p>

      <h3>Hover Details</h3>
      <p>Hovering over any <strong>status cell</strong> in the table shows a tooltip with the member name, service date, and their status — plus attendance result, blockout flag, or notification state where applicable.</p>
      <p>Hovering over a <strong>data point</strong> on the attendance chart shows how many members attended and their percentage of confirmed members for that service. Hovering over the <strong>orange average line</strong> shows the mean attendance across all past services.</p>

      <h3>Status Icons</h3>
      <table class="help-table">
        <tr><td>&#x2705;</td><td><strong>Confirmed</strong> — member has accepted the scheduling request.</td></tr>
        <tr><td>&#x274C;</td><td><strong>Declined</strong> — member has declined.</td></tr>
        <tr><td>&#x23F3;</td><td><strong>Unconfirmed</strong> — notification sent, awaiting response.</td></tr>
        <tr><td>&#x2709;&#xFE0F;</td><td><strong>Notification pending</strong> — rostered but notification not yet sent.</td></tr>
        <tr><td>&middot;</td><td><strong>Not scheduled</strong> — member not on the roster for this service.</td></tr>
        <tr><td>&#x1F44D;</td><td><strong>Attended</strong> — checked in on the day (past plans only).</td></tr>
        <tr><td>&#x1F6AB;</td><td><strong>No-show</strong> — confirmed but did not attend (past plans only).</td></tr>
        <tr><td style="background:repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(148,163,184,0.3) 3px,rgba(148,163,184,0.3) 5px);"></td><td><strong>Blocked out</strong> — member has a blockout date covering this service.</td></tr>
      </table>

      <h3>Row Highlights</h3>
      <table class="help-table">
        <tr><td class="help-swatch" style="background:rgba(127,29,29,0.3);"></td><td><strong>${declineThreshold}+ consecutive declines</strong> — member has declined ${declineThreshold} or more services in a row (blockouts excluded). Unrostered plans do not break the streak.</td></tr>
        <tr><td class="help-swatch" style="background:rgba(234,179,8,0.2);"></td><td><strong>3+ confirmed no-shows</strong> — member confirmed three or more consecutive services but did not attend. Future/untracked plans do not break the streak.</td></tr>
      </table>

      ${roleDefs.length > 0 ? `<h3>Specialist Role Badges</h3>
      <p>Coloured circles appear after a member's name when they hold a specialist role. A muted colour indicates a training variant of the role.</p>
      <table class="help-table">
        ${roleDefs.map(rd =>
          `<tr><td><span class="role-badge" style="background:${rd.color};color:#fff">${rd.key}</span></td><td><strong>${rd.label}</strong></td></tr>`
        ).join('')}
      </table>` : ''}

      <h3>Member Names</h3>
      <p>Names are colour-coded by gender: <span class="gender-f">pink = female</span>, <span class="gender-m">blue = male</span>, white = unknown. An avatar thumbnail is shown where one is available in Planning Center; otherwise a generic silhouette is displayed.</p>

      <h3>Upcoming Services Panel</h3>
      <p>Shows the next four upcoming service dates. For each service time, the count of <span style="color:var(--green)">confirmed</span>, <span style="color:var(--yellow)">pending (notified, no response)</span>, <span style="color:var(--red)">declined</span>, and <span style="color:var(--accent)">✉️ unsent notifications</span> is displayed. Members with an unsent notification are counted only in the unsent bucket, not in pending.</p>

      <h3>Data &amp; Refresh</h3>
      <p>Data is fetched from Planning Center and cached for 60 minutes. To force an immediate refresh, add <code>?refresh=${ORG.refreshKey}</code> to the URL.</p>
      <p>The report covers <strong>2 months past and 2 months future</strong> from today's date.</p>

    </div>
  </div>

  <script>
    (function(){
      const t = localStorage.getItem('theme');
      if(t === 'light') document.body.classList.add('light');
      const btn = document.getElementById('theme-toggle');
      if(btn) {
        btn.textContent = document.body.classList.contains('light') ? '☀️' : '🌙';
        btn.addEventListener('click', function() {
          const isLight = document.body.classList.toggle('light');
          localStorage.setItem('theme', isLight ? 'light' : 'dark');
          btn.textContent = isLight ? '☀️' : '🌙';
        });
      }
    })();
  </script>
  <script>
    (function () {
      let sortCol = 0, sortAsc = true;

      function updateIcons() {
        document.querySelectorAll('th.sortable').forEach(th => {
          const icon = th.querySelector('.sort-icon');
          if (!icon) return;
          const col = parseInt(th.dataset.col, 10);
          if (col === sortCol) {
            icon.textContent = sortAsc ? ' \u25B2' : ' \u25BC';
            icon.classList.add('sort-active');
          } else {
            icon.textContent = ' \u25B3';
            icon.classList.remove('sort-active');
          }
        });
      }

      function sortTable(colIndex) {
        if (sortCol === colIndex) {
          sortAsc = !sortAsc;
        } else {
          sortCol = colIndex;
          sortAsc = true;
        }

        const tbody = document.querySelector('table tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));

        rows.sort((a, b) => {
          const aCell = a.querySelectorAll('td')[colIndex];
          const bCell = b.querySelectorAll('td')[colIndex];
          if (!aCell || !bCell) return 0;

          const aRaw = aCell.dataset.sort ?? aCell.textContent.trim();
          const bRaw = bCell.dataset.sort ?? bCell.textContent.trim();

          const aNum = parseFloat(aRaw);
          const bNum = parseFloat(bRaw);
          let cmp;
          if (!isNaN(aNum) && !isNaN(bNum)) {
            cmp = aNum - bNum;
          } else {
            cmp = aRaw.localeCompare(bRaw);
          }
          return sortAsc ? cmp : -cmp;
        });

        rows.forEach(r => tbody.appendChild(r));
        updateIcons();
      }

      document.querySelectorAll('th.sortable').forEach(th => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => sortTable(parseInt(th.dataset.col, 10)));
      });

      // Default: sort by name ascending on load
      updateIcons();

      // Scroll table so the next upcoming roster column is near the left of the visible area
      requestAnimationFrame(function() {
        const nextCol = document.getElementById('next-roster-col');
        const wrapper = document.querySelector('.grid-wrapper');
        if (nextCol && wrapper) {
          const stickyW = (document.querySelector('th.sticky-col') || {offsetWidth: 0}).offsetWidth;
          wrapper.scrollLeft = nextCol.offsetLeft - stickyW - 8;
        }
      });

      // --- Name + role filters ---
      const filterInput = document.getElementById('name-filter');
      const filterClear = document.getElementById('name-filter-clear');
      let activeRole = null;

      function applyFilter() {
        const q = filterInput.value.trim().toLowerCase();
        filterClear.style.display = q ? 'inline-block' : 'none';
        document.querySelectorAll('table tbody tr').forEach(row => {
          const nameCell = row.querySelector('td[data-sort]');
          const name    = nameCell ? nameCell.dataset.sort        : '';
          const roles   = nameCell ? (nameCell.dataset.roles   || '').split(',') : [];
          const gender  = nameCell ? (nameCell.dataset.gender  || '') : '';
          const marital = nameCell ? (nameCell.dataset.marital || '') : '';
          const age     = nameCell ? (nameCell.dataset.age     || '') : '';
          const nameMatch    = !q             || name.includes(q);
          const roleMatch    = !activeRole    || roles.includes(activeRole);
          const genderMatch  = !activeGender  || gender  === activeGender;
          const maritalMatch = !activeMarital || marital === activeMarital;
          const ageMatch     = !activeAge     || age     === activeAge;
          const login  = nameCell ? (nameCell.dataset.login  || '') : '';
          const loginMatch   = !activeLogin   || login   === activeLogin;
          row.style.display  = (nameMatch && roleMatch && genderMatch && maritalMatch && ageMatch && loginMatch) ? '' : 'none';
        });
      }

      filterInput.addEventListener('input', applyFilter);
      filterClear.addEventListener('click', () => {
        filterInput.value = '';
        applyFilter();
        filterInput.focus();
      });

      document.querySelectorAll('.role-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const role = btn.dataset.role;
          if (activeRole === role) {
            activeRole = null;
            btn.classList.remove('active');
          } else {
            activeRole = role;
            document.querySelectorAll('.role-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          }
          applyFilter();
        });
      });
      // --- Column visibility toggles ---

      function setColVisibility(colIndex, visible) {
        // Toggle th
        const th = document.querySelector('th[data-col="' + colIndex + '"]');
        if (th) th.style.display = visible ? '' : 'none';
        // Toggle all td at that column index
        document.querySelectorAll('table tbody tr').forEach(row => {
          const td = row.querySelectorAll('td')[colIndex];
          if (td) td.style.display = visible ? '' : 'none';
        });
      }

      function getColState() {
        const state = {};
        document.querySelectorAll('.col-toggle').forEach(btn => {
          state[btn.dataset.cols] = btn.classList.contains('active');
        });
        return state;
      }



      function applyInitialColVisibility() {
        // Apply whatever active state the server rendered into the buttons
        document.querySelectorAll('.col-toggle').forEach(btn => {
          const visible = btn.classList.contains('active');
          setColVisibility(parseInt(btn.dataset.cols, 10), visible);
        });
      }

      document.querySelectorAll('.col-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          const nowVisible = !btn.classList.contains('active'); // active = currently visible; click = toggle
          btn.classList.toggle('active', nowVisible);
          const colIdx = parseInt(btn.dataset.cols, 10);
          setColVisibility(colIdx, nowVisible);
        });
      });

      // Apply on load — rAF ensures table is painted before we measure/hide
      requestAnimationFrame(applyInitialColVisibility);

      // --- Gender filter ---
      let activeGender = null;

      window.toggleGenderFilter = function(g) {
        activeGender = activeGender === g ? null : g;
        // Update pie slice opacity
        document.querySelectorAll('.pie-slice').forEach(path => {
          path.style.opacity = (!activeGender || path.dataset.gender === activeGender) ? '1' : '0.25';
        });
        // Update legend opacity
        document.querySelectorAll('.gender-legend-item').forEach(item => {
          const fn = item.querySelector('[class^="gender-"]');
          const itemGender = fn && fn.classList.contains('gender-f') ? 'F' : fn && fn.classList.contains('gender-m') ? 'M' : 'U';
          item.style.opacity = (!activeGender || itemGender === activeGender) ? '1' : '0.4';
        });
        applyFilter();
      };

      // Patch applyFilter to also check gender


      // --- Age range filter ---
      let activeAge = null;
      window.toggleAgeFilter = function(bucket) {
        activeAge = activeAge === bucket ? null : bucket;
        document.querySelectorAll('.age-bar').forEach(el => {
          el.style.opacity = (!activeAge || el.dataset.bucket === activeAge) ? '0.85' : '0.25';
        });
        document.querySelectorAll('.age-bar-label').forEach(el => {
          el.style.opacity = (!activeAge || el.dataset.bucket === activeAge) ? '1' : '0.35';
        });
        applyFilter();
      };

      // --- Login recency filter ---
      let activeLogin = null;
      window.toggleLoginFilter = function(bucket) {
        activeLogin = activeLogin === bucket ? null : bucket;
        document.querySelectorAll('.login-bar').forEach(el => {
          el.style.opacity = (!activeLogin || el.dataset.bucket === activeLogin) ? '0.85' : '0.25';
        });
        document.querySelectorAll('.login-bar-label').forEach(el => {
          el.style.opacity = (!activeLogin || el.dataset.bucket === activeLogin) ? '1' : '0.35';
        });
        applyFilter();
      };

      // --- Marital status filter ---
      let activeMarital = null;
      window.toggleMaritalFilter = function(ms) {
        activeMarital = activeMarital === ms ? null : ms;
        document.querySelectorAll('.pie-slice-m').forEach(p => {
          p.style.opacity = (!activeMarital || p.dataset.marital === activeMarital) ? '1' : '0.25';
        });
        applyFilter();
      };


      // --- Avatar hover popup ---
      const _avatarPopup = document.getElementById('avatar-popup');
      const _table = document.querySelector('table');
      if (_avatarPopup && _table) {
        _table.addEventListener('mouseover', (e) => {
          const wrap = e.target.closest('.member-avatar-wrap');
          if (!wrap) return;
          const img = wrap.querySelector('img.member-avatar');
          if (!img) return;
          _avatarPopup.src = img.src;
          _avatarPopup.style.display = 'block';
          _positionAvatarPopup(e);
        });
        _table.addEventListener('mousemove', (e) => {
          if (_avatarPopup.style.display === 'block') _positionAvatarPopup(e);
        });
        _table.addEventListener('mouseout', (e) => {
          if (!e.target.closest('.member-avatar-wrap')) return;
          if (!e.relatedTarget || !e.relatedTarget.closest('.member-avatar-wrap')) {
            _avatarPopup.style.display = 'none';
          }
        });
      }
      function _positionAvatarPopup(e) {
        const size = 96, offset = 14;
        let x = e.clientX + offset;
        let y = e.clientY - size / 2;
        if (x + size > window.innerWidth)  x = e.clientX - size - offset;
        if (y < 4)                          y = 4;
        if (y + size > window.innerHeight)  y = window.innerHeight - size - 4;
        _avatarPopup.style.left = x + 'px';
        _avatarPopup.style.top  = y + 'px';
      }

      // --- Help modal ---
      const helpBtn = document.getElementById('help-btn');
      const helpModal = document.getElementById('help-modal');
      const helpOverlay = document.getElementById('help-overlay');
      const helpClose = document.getElementById('help-close');

      function openHelp() {
        helpModal.classList.add('open');
        helpOverlay.classList.add('open');
        helpClose.focus();
      }
      function closeHelp() {
        helpModal.classList.remove('open');
        helpOverlay.classList.remove('open');
        helpBtn.focus();
      }

      helpBtn.addEventListener('click', openHelp);
      helpClose.addEventListener('click', closeHelp);
      helpOverlay.addEventListener('click', closeHelp);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });
    })();
  </script>
</body>
</html>`;
}

export { fetchTeamData, renderHTML, localDateStr };