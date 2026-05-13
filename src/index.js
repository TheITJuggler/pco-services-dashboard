// PCO Team Report — Cloudflare Worker entry point
import { fetchTeamData, renderHTML, localDateStr } from "./shared.js";
import { TEAMS, getTeam } from "./teams.js";
import { ORG } from "./config.js";
const REFRESH_KEY      = ORG.refreshKey;
const TTL              = ORG.ttl;
const FULL_TTL_SEC     = TTL.blockouts;        // governs full payload cache lifetime
const PREWARM_LEAD_SEC = TTL.prewarmLeadSec;   // alarm lead time before expiry

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---------------------------------------------------------------------------
// PCODataCache — Durable Object (one instance per team slug)
// Responsibilities:
//   1. Serve cached data from R2 if fresh
//   2. Coordinate fetch lock to prevent concurrent PCO fetches
//   3. Schedule alarm-based pre-warming so users never hit a cold cache
// ---------------------------------------------------------------------------
export class PCODataCache {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url          = new URL(request.url);
    const teamSlug     = url.searchParams.get("team") || ORG.defaultTeam || "adult-choir";
    const forceRefresh = url.searchParams.get("refresh") === REFRESH_KEY;
    const teamConfig   = getTeam(teamSlug);
    if (!teamConfig) return new Response("Unknown team", { status: 404 });

    if (!forceRefresh) {
      const cached = await this._readR2(teamSlug);
      if (cached) return new Response(cached, { headers: { "Content-Type": "application/json" } });
    }

    // Fetch lock — prevent concurrent PCO fetches for the same team
    const lockKey = `lock:${teamSlug}`;
    const isFetching = await this.state.storage.get(lockKey);
    if (isFetching) {
      // Wait up to 60s for the in-flight fetch to complete
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const cached = await this._readR2(teamSlug);
        if (cached) return new Response(cached, { headers: { "Content-Type": "application/json" } });
      }
      // Timeout — fall through and fetch anyway
    }

    return await this._doFetch(teamSlug, teamConfig, lockKey);
  }

  async alarm() {
    // Pre-warm all teams that have a registered alarm
    const teamSlugs = await this.state.storage.get("alarmTeams") || [];
    console.log(`[DO alarm] Pre-warming ${teamSlugs.length} team(s): ${teamSlugs.join(", ")}`);

    for (const teamSlug of teamSlugs) {
      const teamConfig = getTeam(teamSlug);
      if (!teamConfig) continue;
      const lockKey = `lock:${teamSlug}`;
      try {
        await this._doFetch(teamSlug, teamConfig, lockKey);
        console.log(`[DO alarm] Pre-warm complete: ${teamSlug}`);
      } catch (err) {
        console.error(`[DO alarm] Pre-warm failed: ${teamSlug} — ${err.message}`);
      }
    }

    // Re-schedule next alarm
    await this._scheduleAlarm();
  }

  async _doFetch(teamSlug, teamConfig, lockKey) {
    await this.state.storage.put(lockKey, true);
    try {
      console.log(`[DO] Fetching PCO data for team=${teamSlug}`);
      const data    = await fetchTeamData(this.env, teamConfig);
      const payload = JSON.stringify(serializeData(data));

      // Store in R2 with layer metadata
      const r2Key = `${ORG.r2Prefix}/${teamSlug}/data.json`;
      await this.env.PCO_CACHE.put(r2Key, payload, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          fetchedAt: new Date().toISOString(),
          ttl:       String(FULL_TTL_SEC),
          teamSlug,
        },
      });

      // Register this team for alarm pre-warming
      const existing = await this.state.storage.get("alarmTeams") || [];
      if (!existing.includes(teamSlug)) {
        existing.push(teamSlug);
        await this.state.storage.put("alarmTeams", existing);
      }

      // Schedule pre-warm alarm if not already set
      await this._scheduleAlarm();

      return new Response(payload, { headers: { "Content-Type": "application/json" } });
    } finally {
      await this.state.storage.delete(lockKey);
    }
  }

  async _scheduleAlarm() {
    // Only schedule if not already pending
    const existing = await this.state.storage.getAlarm();
    if (existing) return;
    const nextAlarm = Date.now() + (FULL_TTL_SEC - PREWARM_LEAD_SEC) * 1000;
    await this.state.storage.setAlarm(nextAlarm);
    console.log(`[DO] Alarm scheduled for ${new Date(nextAlarm).toISOString()}`);
  }

  async _readR2(teamSlug) {
    try {
      const r2Key = `${ORG.r2Prefix}/${teamSlug}/data.json`;
      const obj   = await this.env.PCO_CACHE.get(r2Key);
      if (!obj) return null;
      const fetchedAt = obj.customMetadata?.fetchedAt;
      const ttl       = parseInt(obj.customMetadata?.ttl || String(FULL_TTL_SEC), 10);
      if (fetchedAt && Date.now() - new Date(fetchedAt).getTime() > ttl * 1000) return null;
      return await obj.text();
    } catch { return null; }
  }
}

// ---------------------------------------------------------------------------
// Device type detection
// ---------------------------------------------------------------------------
function detectDevice(request) {
  // Cloudflare provides cf.deviceType on real requests
  if (request.cf && request.cf.deviceType) return request.cf.deviceType; // 'mobile'|'tablet'|'desktop'
  // Fallback: User-Agent sniffing
  const ua = (request.headers.get('User-Agent') || '').toLowerCase();
  if (/ipad|android(?!.*mobile)|tablet/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry|windows phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

// ---------------------------------------------------------------------------
// Serialize / deserialize Maps and Sets for R2 JSON storage
// ---------------------------------------------------------------------------
function serializeData(data) {
  return {
    columns:      data.columns,
    teamConfig:   data.teamConfig,
    apiCallCount: data.apiCallCount,
    duration:     data.duration,
    genderMap:      Object.fromEntries(data.genderMap),
    avatarMap:      Object.fromEntries(data.avatarMap),
    joinDateMap:    Object.fromEntries(data.joinDateMap    || new Map()),
    birthdateMap:   Object.fromEntries(data.birthdateMap   || new Map()),
    anniversaryMap: Object.fromEntries(data.anniversaryMap || new Map()),
    maritalMap:     Object.fromEntries(data.maritalMap     || new Map()),
    loginMap:       Object.fromEntries(data.loginMap       || new Map()),
    memberAddedMap: Object.fromEntries(data.memberAddedMap || new Map()),
    positionMap:  Object.fromEntries([...data.positionMap.entries()].map(([id, s]) => [id, [...s]])),
    peopleMap:    Object.fromEntries([...data.peopleMap.entries()].map(([id, p]) => [id, {
      ...p,
      statuses:        Object.fromEntries(p.statuses),
      attended:        Object.fromEntries(p.attended),
      blockedOut:      Object.fromEntries(p.blockedOut),
      prepareNotif:    Object.fromEntries(p.prepareNotif),
      notifSentAt:     Object.fromEntries(p.notifSentAt),
      statusUpdatedAt: Object.fromEntries(p.statusUpdatedAt || new Map()),
      positions:       [...p.positions],
    }])),
  };
}

function deserializeData(obj) {
  return {
    columns:      obj.columns,
    teamConfig:   obj.teamConfig,
    apiCallCount: obj.apiCallCount,
    duration:     obj.duration,
    genderMap:      new Map(Object.entries(obj.genderMap)),
    avatarMap:      new Map(Object.entries(obj.avatarMap)),
    joinDateMap:    new Map(Object.entries(obj.joinDateMap    || {})),
    birthdateMap:   new Map(Object.entries(obj.birthdateMap   || {})),
    anniversaryMap: new Map(Object.entries(obj.anniversaryMap || {})),
    maritalMap:     new Map(Object.entries(obj.maritalMap     || {})),
    loginMap:       new Map(Object.entries(obj.loginMap       || {})),
    memberAddedMap: new Map(Object.entries(obj.memberAddedMap || {})),
    positionMap:  new Map(Object.entries(obj.positionMap).map(([id, arr]) => [id, new Set(arr)])),
    peopleMap:    new Map(Object.entries(obj.peopleMap).map(([id, p]) => [id, {
      ...p,
      statuses:        new Map(Object.entries(p.statuses)),
      attended:        new Map(Object.entries(p.attended)),
      blockedOut:      new Map(Object.entries(p.blockedOut)),
      prepareNotif:    new Map(Object.entries(p.prepareNotif)),
      notifSentAt:     new Map(Object.entries(p.notifSentAt)),
      statusUpdatedAt: new Map(Object.entries(p.statusUpdatedAt || {})),
      declineReason:   new Map(Object.entries(p.declineReason || {})),
      positions:       new Set(p.positions),
    }])),
  };
}

// ---------------------------------------------------------------------------
// R2 helper — read with TTL check, returns { text, fetchedAt, ttl } or null
// ---------------------------------------------------------------------------
async function readR2(env, r2Key, ttlOverride) {
  try {
    const obj = await env.PCO_CACHE.get(r2Key);
    if (!obj) return null;
    const fetchedAt = obj.customMetadata?.fetchedAt;
    const ttl       = ttlOverride ?? parseInt(obj.customMetadata?.ttl || String(FULL_TTL_SEC), 10);
    if (fetchedAt && Date.now() - new Date(fetchedAt).getTime() > ttl * 1000) return null;
    return { text: await obj.text(), fetchedAt, ttl };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Executive summary page
// ---------------------------------------------------------------------------
async function renderExecSummary(env, userEmail = null) {
  const now = new Date();
  const _todayLocal = localDateStr(now);

  // Load all team data from R2 in parallel
  const teamDatasets = await Promise.all(TEAMS.map(async (team) => {
    const r2Key  = `${ORG.r2Prefix}/${team.slug}/data.json`;
    const cached = await readR2(env, r2Key);
    if (!cached) return { team, data: null, cached: null };
    return { team, data: deserializeData(JSON.parse(cached.text)), cached };
  }));

  // ── Collect upcoming Sunday dates across all teams (next 4 distinct dates) ──
  const allFutureDates = new Set();
  for (const { data } of teamDatasets) {
    if (!data) continue;
    for (const col of data.columns) {
      if (col.sortDate.slice(0, 10) >= _todayLocal) allFutureDates.add(col.sortDate.slice(0, 10));
    }
  }
  const upcomingDates = [...allFutureDates].sort().slice(0, ORG.upcomingDatesCount || 4);

  // ── Build upcoming services grid ──────────────────────────────────────────
  let servicesGrid = "";
  if (upcomingDates.length > 0) {
    const dateHeaders = upcomingDates.map(d => {
      const [, mm, dd] = d.split("-").map(Number);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `<th>${months[mm-1]} ${dd}</th>`;
    }).join("");

    // Total row — sum confirmed/rostered across all teams per date
    const totalCells = upcomingDates.map(date => {
      let totalConfirmed = 0, totalRostered = 0;
      for (const { data } of teamDatasets) {
        if (!data) continue;
        const people = [...data.peopleMap.entries()]
          .filter(([id]) => data.positionMap.size === 0 || data.positionMap.has(id));
        const dateCols = data.columns.filter(c => c.sortDate.startsWith(date) && c.sortDate.slice(0, 10) >= _todayLocal);
        for (const col of dateCols) {
          for (const [, pd] of people) {
            const s = pd.statuses.get(col.key);
            if (!s) continue;
            totalRostered++;
            if (s === "C") totalConfirmed++;
          }
        }
      }
      if (totalRostered === 0) return '<td class="sg-cell sg-none">·</td>';
      const pct = Math.round(totalConfirmed / totalRostered * 100);
      const cls = (ORG.pctThresholds&&ORG.pctThresholds.high||70) <= pct ? "sg-hi" : (ORG.pctThresholds&&ORG.pctThresholds.medium||40) <= pct ? "sg-mid" : "sg-lo";
      return '<td class="sg-cell sg-total ' + cls + '">' + totalConfirmed + '/' + totalRostered + '</td>';
    }).join("");
    const totalRow = '<tr class="sg-total-row"><td class="sg-team sg-total-label">All Teams</td>' + totalCells + '</tr>';

    const teamRows = teamDatasets.slice().sort((a, b) => a.team.label.localeCompare(b.team.label)).map(({ team, data }) => {
      if (!data) return `<tr><td class="sg-team"><a href="/team/${team.slug}">${team.icon} ${team.label}</a></td>${upcomingDates.map(() => '<td class="sg-cell sg-cold">—</td>').join("")}</tr>`;

      const people = [...data.peopleMap.entries()]
        .filter(([id]) => data.positionMap.size === 0 || data.positionMap.has(id));

      const cells = upcomingDates.map(date => {
        const dateCols = data.columns.filter(c => c.sortDate.startsWith(date) && c.sortDate.slice(0, 10) >= _todayLocal);
        if (dateCols.length === 0) return '<td class="sg-cell sg-none">·</td>';

        // Aggregate across all service times on this date for this team
        let confirmed = 0, pending = 0, declined = 0, unsent = 0, total = 0;
        for (const col of dateCols) {
          for (const [, pd] of people) {
            const s     = pd.statuses.get(col.key);
            const sent  = pd.notifSentAt?.get(col.key);
            const prep  = pd.prepareNotif?.get(col.key);
            if (!s) continue;
            total++;
            if (s === "C") confirmed++;
            else if (s === "D") declined++;
            else if (s === "U" && prep && !sent) unsent++;
            else if (s === "U") pending++;
          }
        }
        if (total === 0) return '<td class="sg-cell sg-none">·</td>';
        const pct    = Math.round(confirmed / total * 100);
        const cls    = (ORG.pctThresholds&&ORG.pctThresholds.high||70) <= pct ? "sg-hi" : (ORG.pctThresholds&&ORG.pctThresholds.medium||40) <= pct ? "sg-mid" : "sg-lo";
        const detail = confirmed + "/" + total;
        const unsentBadge = unsent > 0 ? ` <span class="sg-unsent">✉ ${unsent}</span>` : "";
        // Plan notes — title/series from the plan record (no extra API call)
        const notes = [...new Set(dateCols.flatMap(c => [c.series, c.title].filter(Boolean)))];
        const notesBadge = notes.length > 0 ? ` <span class="sg-note" title="${notes.join(" · ")}">📝</span>` : "";
        return `<td class="sg-cell ${cls}" title="${confirmed} confirmed, ${pending} pending, ${declined} declined${unsent > 0 ? ", " + unsent + " unsent" : ""}${notes.length > 0 ? " | " + notes.join(" · ") : ""}">${detail}${unsentBadge}${notesBadge}</td>`;
      }).join("");

      return `<tr><td class="sg-team"><a href="/team/${team.slug}">${team.icon} ${team.label}</a></td>${cells}</tr>`;
    }).join("");

    servicesGrid = `
    <div class="exec-panel exec-panel--collapsible" id="sg-panel">
      <button type="button" class="exec-panel__toggle" onclick="this.closest('.exec-panel--collapsible').classList.toggle('open')" aria-expanded="false">
        <span class="exec-panel__title">📅 Upcoming Services — Confirmed / Rostered</span>
        <span class="exec-panel__chevron">▸</span>
      </button>
      <div class="exec-panel__summary">
        <div class="sg-wrap">
          <table class="sg-table">
            <thead><tr><th>Team</th>${dateHeaders}</tr></thead>
            <tbody>${totalRow}</tbody>
          </table>
        </div>
      </div>
      <div class="exec-panel__body">
        <div class="sg-wrap">
          <table class="sg-table">
            <thead><tr><th>Team</th>${dateHeaders}</tr></thead>
            <tbody>${teamRows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  }


  // ── Team cards ────────────────────────────────────────────────────────────
  const teamCards = teamDatasets.slice().sort((a, b) => a.team.label.localeCompare(b.team.label)).map(({ team, data, cached }) => {
    if (!data) {
      return `<a href="/team/${team.slug}" class="team-card team-card--cold">
        <div class="team-card__header">
          <span class="team-card__icon">${team.icon}</span>
          <span class="team-card__name">${team.label}</span>
        </div>
        <div class="team-card__status cold">No data cached — click to generate</div>
        <div class="team-card__action">Generate Report →</div>
      </a>`;
    }

    const people  = [...data.peopleMap.entries()]
      .filter(([id]) => data.positionMap.size === 0 || data.positionMap.has(id));
    const total   = data.positionMap.size > 0 ? data.positionMap.size : people.length;
    const columns = data.columns;
    const future  = columns.filter(c => c.sortDate.slice(0, 10) >= _todayLocal);

    const perPersonPcts = [];
    for (const [, pd] of people) {
      let c = 0, d = 0;
      for (const [key, s] of pd.statuses) {
        if (s === "C") c++;
        else if (s === "D" && !pd.blockedOut.get(key)) d++;
      }
      if (c + d > 0) perPersonPcts.push(Math.round(c / (c + d) * 100));
    }
    const confirmedPct = perPersonPcts.length > 0
      ? Math.round(perPersonPcts.reduce((a, b) => a + b, 0) / perPersonPcts.length) : null;

    let nextConfirmed = 0, nextTotal = 0;
    if (future.length > 0) {
      const nextCol = future[0];
      for (const [, pd] of people) {
        const s = pd.statuses.get(nextCol.key);
        if (s) { nextTotal++; if (s === "C") nextConfirmed++; }
      }
    }

    const ageMin  = cached.fetchedAt ? Math.round((Date.now() - new Date(cached.fetchedAt).getTime()) / 60000) : null;
    const ageStr  = ageMin === null ? "unknown" : ageMin < 1 ? "just now" : ageMin + "m ago";
    const nextLabel = future.length > 0
      ? new Date(future[0].sortDate).toLocaleDateString(ORG.locale || "en-AU", { day: "numeric", month: "short", timeZone: ORG.timezone || "UTC" }) : "—";
    const pctCls  = confirmedPct !== null ? (confirmedPct >= (ORG.pctThresholds&&ORG.pctThresholds.high||70) ? "hi" : confirmedPct >= (ORG.pctThresholds&&ORG.pctThresholds.medium||40) ? "mid" : "lo") : "";

    return `<a href="/team/${team.slug}" class="team-card">
      <div class="team-card__header">
        <span class="team-card__icon">${team.icon}</span>
        <span class="team-card__name">${team.label}</span>
      </div>
      <div class="team-card__stats">
        <div class="team-stat"><span class="team-stat__val">${total}</span><span class="team-stat__lbl">Members</span></div>
        <div class="team-stat"><span class="team-stat__val ${pctCls}">${confirmedPct !== null ? confirmedPct + "%" : "—"}</span><span class="team-stat__lbl">Confirmed</span></div>
        <div class="team-stat"><span class="team-stat__val">${nextConfirmed}/${nextTotal}</span><span class="team-stat__lbl">Next (${nextLabel})</span></div>
      </div>
      <div class="team-card__status">Refreshed ${ageStr}</div>
      <div class="team-card__action">View Report →</div>
    </a>`;
  });

  // ── Org-wide demographics & occasions ────────────────────────────────────
  const orgGender = { F:0, M:0, U:0 };
  const orgMarital = {};
  const orgAgeCount = { '<20':0,'20–24':0,'25–29':0,'30–34':0,'35–39':0,'40–44':0,'45–49':0,'50–54':0,'55+':0 };
  const orgOccasions = { thisWeek:[], nextWeek:[] };
  // Use org timezone so week boundaries roll over at local midnight
  const _todayParts = new Date().toLocaleDateString('en-CA', { timeZone: ORG.timezone || 'UTC' }).split('-').map(Number);
  const todayExec = new Date(_todayParts[0], _todayParts[1] - 1, _todayParts[2]);
  // Week start day from config (0=Sun, 1=Mon, …)
  const _wsd = ORG.weekStartDay ?? 0;
  const dayExec = todayExec.getDay();
  const _offset = (dayExec - _wsd + 7) % 7;
  // This week (boundaries depend on weekStartDay)
  const thisWkStart = new Date(todayExec); thisWkStart.setDate(todayExec.getDate() - _offset);
  const thisWkEnd   = new Date(thisWkStart); thisWkEnd.setDate(thisWkStart.getDate() + 6);
  // Next week
  const nextWkStart = new Date(thisWkStart); nextWkStart.setDate(thisWkStart.getDate() + 7);
  const nextWkEnd   = new Date(thisWkStart); nextWkEnd.setDate(thisWkStart.getDate() + 13);

  // Format "3rd May" style
  function ordinal(n) { const s=['th','st','nd','rd']; const v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }
  const MNAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmtRangeDate(d) { return ordinal(d.getDate()) + ' ' + MNAMES[d.getMonth()]; }
  const nextWeekLabel = '(' + fmtRangeDate(nextWkStart) + ' – ' + fmtRangeDate(nextWkEnd) + ')';
  const thisWeekLabel = '(' + fmtRangeDate(thisWkStart) + ' – ' + fmtRangeDate(thisWkEnd) + ')';
  const seenPersonIds = new Set();

  for (const { data } of teamDatasets) {
    if (!data) continue;
    const people = [...data.peopleMap.entries()]
      .filter(([id]) => data.positionMap.size === 0 || data.positionMap.has(id));
    for (const [id, pd] of people) {
      if (seenPersonIds.has(id)) continue; // deduplicate cross-team members
      seenPersonIds.add(id);
      // Gender
      const g = data.genderMap?.get(id);
      if (g === "F") orgGender.F++; else if (g === "M") orgGender.M++; else orgGender.U++;
      // Marital
      const ms = data.maritalMap?.get(id) || "Unknown";
      orgMarital[ms] = (orgMarital[ms] || 0) + 1;
      // Age
      const bd = data.birthdateMap?.get(id);
      if (bd) {
        const [y,m,d] = bd.slice(0,10).split('-').map(Number);
        let age = todayExec.getFullYear() - y;
        if (todayExec.getMonth()+1 < m || (todayExec.getMonth()+1===m && todayExec.getDate()<d)) age--;
        const key = age<20?'<20':age<25?'20–24':age<30?'25–29':age<35?'30–34':age<40?'35–39':age<45?'40–44':age<50?'45–49':age<55?'50–54':'55+';
        if (key in orgAgeCount) orgAgeCount[key]++;
        // Birthdays
        const bOcc = occExec(bd);
        if (bOcc !== null) orgOccasions[bOcc.week].push({ personId:id, name:pd.name, type:'🎂', label:'Birthday', sortKey:bOcc.sortKey, dateLabel:bOcc.dateLabel });
      }
      // Anniversaries
      const ann = data.anniversaryMap?.get(id);
      if (ann) {
        const aOcc = occExec(ann);
        if (aOcc !== null) orgOccasions[aOcc.week].push({ personId:id, name:pd.name, type:'💍', label:'Anniversary', sortKey:aOcc.sortKey, dateLabel:aOcc.dateLabel });
      }
    }
  }

  // Returns { week: 'thisWeek'|'nextWeek', sortKey, dateLabel } or null
  // ── Cross-team membership count ─────────────────────────────────────────
  // personId -> Set of team slugs they belong to
  const personTeamSlugs = new Map();
  const warmTeamCount = teamDatasets.filter(t => t.data).length;
  // Build slug -> label lookup and parent-child graph
  const slugToLabel = new Map(TEAMS.map(t => [t.slug, t.label]));
  const childToParent = new Map(TEAMS.filter(t => t.parentTeam).map(t => [t.slug, t.parentTeam]));
  for (const { team, data } of teamDatasets) {
    if (!data) continue;
    const memberIds = data.positionMap.size > 0
      ? [...data.positionMap.keys()]
      : [...data.peopleMap.keys()];
    for (const id of memberIds) {
      if (!personTeamSlugs.has(id)) personTeamSlugs.set(id, new Set());
      personTeamSlugs.get(id).add(team.slug);
    }
  }
  // Collapse parent-child pairs into one "team group" for overlap counting.
  // A person on both "vocals" (child) and "adult-choir" (parent) counts as 1 group.
  const personTeams = new Map();
  for (const [id, slugs] of personTeamSlugs) {
    const groups = new Set();
    for (const slug of slugs) {
      const parent = childToParent.get(slug);
      if (parent && slugs.has(parent)) {
        // Child + parent both present → count as parent group only
        groups.add(slugToLabel.get(parent) || parent);
      } else {
        groups.add(slugToLabel.get(slug) || slug);
      }
    }
    personTeams.set(id, groups);
  }
  // Build parentSlug -> Set of child slugs lookup
  const parentToChildren = new Map();
  for (const [child, parent] of childToParent) {
    if (!parentToChildren.has(parent)) parentToChildren.set(parent, new Set());
    parentToChildren.get(parent).add(child);
  }
  // Bucket by team group count
  const multiTeamBuckets = { 1:[], 2:[], 3:[], 4:[], '5+':[] };
  for (const [id, teams] of personTeams) {
    const n = teams.size;
    const key = n >= 5 ? '5+' : String(n);
    // Format team names: show "Parent/Child" for parent-child pairs, plain label otherwise
    const slugs = personTeamSlugs.get(id);
    const formatted = [];
    const handled = new Set();
    for (const slug of slugs) {
      if (handled.has(slug)) continue;
      const parent = childToParent.get(slug);
      if (parent && slugs.has(parent)) continue; // handled when we process the parent
      const children = parentToChildren.get(slug);
      if (children) {
        const activeChildren = [...children].filter(c => slugs.has(c));
        if (activeChildren.length > 0) {
          const parentLabel = slugToLabel.get(slug) || slug;
          const childLabels = activeChildren.map(c => slugToLabel.get(c) || c).sort();
          formatted.push(parentLabel + '/' + childLabels.join('/'));
          for (const c of activeChildren) handled.add(c);
          handled.add(slug);
          continue;
        }
      }
      formatted.push(slugToLabel.get(slug) || slug);
      handled.add(slug);
    }
    multiTeamBuckets[key].push({ id, teams: formatted.sort() });
  }

  // Build horizontal bar chart
  let multiTeamHTML = '';
  const mtTotal = personTeams.size;
  if (mtTotal > 0 && warmTeamCount > 1) {
    const bucketKeys = ['2','3','4','5+'];
    const mtMax = Math.max(...bucketKeys.map(k => multiTeamBuckets[k].length), 1);
    const mtBars = bucketKeys.map(k => {
      const count = multiTeamBuckets[k].length;
      if (count === 0) return '';
      const pct = Math.round(count / mtMax * 100);
      const label = k + ' teams';
      // Tooltip: list names for small counts, otherwise just count
      const names = multiTeamBuckets[k].slice(0, 10)
        .map(e => {
          // find name from any dataset
          let name = '';
          for (const { data } of teamDatasets) {
            if (data && data.peopleMap.has(e.id)) { name = data.peopleMap.get(e.id).name; break; }
          }
          return name + ' (' + e.teams.join(', ') + ')';
        }).join('\n') + (multiTeamBuckets[k].length > 10 ? '\n…and ' + (multiTeamBuckets[k].length - 10) + ' more' : '');
      const color = k === '2' ? '#8b5cf6' : k === '3' ? '#f97316' : k === '4' ? '#ef4444' : '#dc2626';
      return '<div style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.78rem;">'
        + '<span style="width:3.5rem;color:#94a3b8;flex-shrink:0;">' + label + '</span>'
        + '<div style="flex:1;background:#334155;border-radius:3px;height:14px;overflow:hidden;">'
        + '<div title="' + names.replace(/"/g, '&quot;') + '" style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:3px;cursor:help;"></div>'
        + '</div>'
        + '<span style="min-width:2rem;text-align:right;font-weight:600;color:#f1f5f9;">' + count + '</span>'
        + '</div>';
    }).join('');
    const footnote = warmTeamCount < teamDatasets.length
      ? '<div style="font-size:0.7rem;color:#94a3b8;margin-top:0.4rem;">Based on ' + warmTeamCount + ' of ' + teamDatasets.length + ' teams (others not yet cached)</div>'
      : '';
    multiTeamHTML = '<div style="flex:0 0 auto;min-width:200px;">'
      + '<div style="font-size:0.72rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.5rem;">Team Overlap</div>'
      + mtBars + footnote + '</div>';
  }

  // ── Consolidated last login chart across all teams ────────────────────
  const LOGIN_BUCKETS_EXEC = (ORG.loginBuckets || [
    { label: '<7d', min: 0, max: 7 }, { label: '8\u201314d', min: 8, max: 14 },
    { label: '15\u201321d', min: 15, max: 21 }, { label: '>21d', min: 22, max: Infinity },
    { label: 'Never', min: -1, max: -1 },
  ]);
  const loginCountsExec = LOGIN_BUCKETS_EXEC.map(b => ({ ...b, count: 0 }));
  const seenLoginIds = new Set();
  const nowMsExec = Date.now();
  for (const { data } of teamDatasets) {
    if (!data) continue;
    const memberIds = data.positionMap.size > 0 ? [...data.positionMap.keys()] : [...data.peopleMap.keys()];
    for (const id of memberIds) {
      if (seenLoginIds.has(id)) continue;
      seenLoginIds.add(id);
      const lastLogin = (data.loginMap || new Map()).get(id);
      if (!lastLogin) {
        loginCountsExec[4].count++;
      } else {
        const daysAgo = Math.floor((nowMsExec - new Date(lastLogin).getTime()) / 86400000);
        if (daysAgo <= 7)       loginCountsExec[0].count++;
        else if (daysAgo <= 14) loginCountsExec[1].count++;
        else if (daysAgo <= 21) loginCountsExec[2].count++;
        else                    loginCountsExec[3].count++;
      }
    }
  }
  let loginExecHTML = '';
  if (seenLoginIds.size > 0) {
    const lMax = Math.max(...loginCountsExec.map(b => b.count), 1);
    const lBars = LOGIN_BUCKETS_EXEC.map((b, i) => {
      const count = loginCountsExec[i].count;
      if (count === 0) return '';
      const pct = Math.round(count / lMax * 100);
      const color = b.min === -1 ? '#ef4444' : b.max <= 7 ? '#22c55e' : b.max <= 14 ? '#3b82f6' : b.max <= 21 ? '#f59e0b' : '#f97316'; // >21d = orange, Never = red
      const escLabel = b.label.replace(/</g, '&lt;');
      return '<div style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.78rem;">'
        + '<span style="width:4rem;color:#94a3b8;flex-shrink:0;">' + escLabel + '</span>'
        + '<div style="flex:1;background:#334155;border-radius:3px;height:14px;overflow:hidden;">'
        + '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:3px;"></div>'
        + '</div>'
        + '<span style="min-width:2rem;text-align:right;font-weight:600;color:#f1f5f9;">' + count + '</span>'
        + '</div>';
    }).join('');
    const loginFootnote = warmTeamCount < teamDatasets.length
      ? '<div style="font-size:0.7rem;color:#94a3b8;margin-top:0.4rem;">Based on ' + warmTeamCount + ' of ' + teamDatasets.length + ' teams</div>'
      : '';
    loginExecHTML = '<div style="flex:0 0 auto;min-width:200px;">'
      + '<div style="font-size:0.72rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.5rem;">Last Login</div>'
      + lBars + loginFootnote + '</div>';
  }

  function occExec(dateStr) {
    if (!dateStr) return null;
    const [,mm,dd] = dateStr.slice(0,10).split('-').map(Number);
    const yr = todayExec.getFullYear();
    // Try this year and last year (for past week crossing year boundary edge case)
    for (const y of [yr, yr-1, yr+1]) {
      const occ = new Date(y, mm-1, dd);
      if (occ >= thisWkStart && occ <= thisWkEnd) return { week:'thisWeek', sortKey: occ.getTime(), dateLabel: fmtRangeDate(occ) };
      if (occ >= nextWkStart && occ <= nextWkEnd) return { week:'nextWeek', sortKey: occ.getTime(), dateLabel: fmtRangeDate(occ) };
    }
    return null;
  }

  // Build a map: personId -> confirmed service timings this/last week (across all teams)
  const personConfirmedServices = new Map(); // personId -> Set of timeLabel strings
  for (const { data } of teamDatasets) {
    if (!data) continue;
    const futureCols = data.columns.filter(c => {
      const d = new Date(c.sortDate);
      return d >= thisWkStart && d <= nextWkEnd;
    });
    for (const col of futureCols) {
      for (const [pid, pd] of data.peopleMap) {
        if (pd.statuses.get(col.key) === 'C') {
          if (!personConfirmedServices.has(pid)) personConfirmedServices.set(pid, new Set());
          personConfirmedServices.get(pid).add(col.timeLabel);
        }
      }
    }
  }

  // Occasions panel
  let execOccasionsHTML = "";
  if (orgOccasions.thisWeek.length > 0 || orgOccasions.nextWeek.length > 0) {
    // Sort each list by date
    orgOccasions.thisWeek.sort((a,b) => a.sortKey - b.sortKey);
    orgOccasions.nextWeek.sort((a,b) => a.sortKey - b.sortKey);

    // Group occasions by service time (for confirmed rostered members)
    // Returns HTML for a list of occasions
    const renderOccasionList = list => {
      if (list.length === 0) return '<span style="color:#94a3b8;font-size:0.8rem;">None</span>';

      // Separate: confirmed-rostered (group by service) vs not rostered
      const byService = {}; // timeLabel -> [{name, type, label, dateLabel}]
      const unrostered = [];

      for (const o of list) {
        const times = personConfirmedServices.get(o.personId);
        if (times && times.size > 0) {
          for (const t of times) {
            if (!byService[t]) byService[t] = [];
            byService[t].push(o);
          }
        } else {
          unrostered.push(o);
        }
      }

      let html = '';
      // Render service groups sorted by time
      const timeOrder = ['8am','9am','10am','11am','12pm','1pm','5pm','6pm','7pm'];
      const sortedTimes = Object.keys(byService).sort((a,b) => {
        const ai = timeOrder.indexOf(a), bi = timeOrder.indexOf(b);
        return (ai===-1?99:ai) - (bi===-1?99:bi);
      });
      for (const t of sortedTimes) {
        html += '<div style="margin-bottom:0.4rem;">'
          + '<span style="font-size:0.7rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.04em;">' + t + '</span>';
        for (const o of byService[t]) {
          html += '<div style="font-size:0.83rem;padding:0.1rem 0 0.1rem 0.5rem;">'
            + o.type + ' <strong>' + o.name + '</strong>'
            + ' <span style="color:var(--text-muted);font-size:0.78rem;">(' + o.dateLabel + ')</span>'
            + ' — ' + o.label + '</div>';
        }
        html += '</div>';
      }
      // Unrostered (no confirmed service that week) — collapsible, starts collapsed
      if (unrostered.length > 0) {
        const unrosteredItems = unrostered.map(o =>
          '<div style="font-size:0.83rem;padding:0.1rem 0 0.1rem 0.5rem;">'
          + o.type + ' <strong>' + o.name + '</strong>'
          + ' <span style="color:var(--text-muted);font-size:0.78rem;">(' + o.dateLabel + ')</span>'
          + ' — ' + o.label + '</div>'
        ).join('');
        html += '<details style="margin-top:0.5rem;">'
          + '<summary style="font-size:0.7rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;cursor:pointer;user-select:none;list-style:none;display:flex;align-items:center;gap:0.4rem;">'
          + '<span class="details-chevron" style="font-size:0.65rem;transition:transform 0.2s;display:inline-block;">▸</span>'
          + 'Not rostered this week (' + unrostered.length + ')</summary>'
          + '<div style="margin-top:0.3rem;">' + unrosteredItems + '</div>'
          + '</details>';
      }
      return html;
    };

    const hdrStyle = 'font-size:0.72rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem;';
    execOccasionsHTML = '<div class="exec-panel"><div class="exec-panel__title">🎉 Birthdays &amp; Anniversaries</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;">'
      + '<div><div style="' + hdrStyle + '">This Week <span style="font-weight:400;text-transform:none;letter-spacing:0;">' + thisWeekLabel + '</span></div>' + renderOccasionList(orgOccasions.thisWeek) + '</div>'
      + '<div><div style="' + hdrStyle + '">Next Week <span style="font-weight:400;text-transform:none;letter-spacing:0;">' + nextWeekLabel + '</span></div>' + renderOccasionList(orgOccasions.nextWeek) + '</div>'
      + '</div></div>';
  }

  // Demographics panel (gender + marital pies + age bar)
  function buildExecPie(counts, colors, W, H) {
    const total = Object.values(counts).reduce((a,b)=>a+b,0);
    if (total === 0) return '';
    const cx=70,cy=70,r=55;
    let angle=0;
    const paths = Object.entries(counts).filter(([,c])=>c>0).map(([label,count]) => {
      let sweep = count/total*2*Math.PI;
      if (sweep >= 2*Math.PI) sweep = 2*Math.PI-0.0001;
      const x1=cx+r*Math.sin(angle), y1=cy-r*Math.cos(angle);
      const x2=cx+r*Math.sin(angle+sweep), y2=cy-r*Math.cos(angle+sweep);
      const large=sweep>Math.PI?1:0;
      const path='M '+cx+' '+cy+' L '+x1.toFixed(2)+' '+y1.toFixed(2)+' A '+r+' '+r+' 0 '+large+' 1 '+x2.toFixed(2)+' '+y2.toFixed(2)+' Z';
      angle+=sweep;
      return '<path d="'+path+'" fill="'+(colors[label]||'#64748b')+'"><title>'+label+': '+count+'</title></path>';
    }).join('');
    const legend = Object.entries(counts).filter(([,c])=>c>0).map(([label,count]) =>
      '<div style="font-size:0.75rem;display:flex;align-items:center;gap:0.3rem;line-height:1.8;">'
      +'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+(colors[label]||'#64748b')+'"></span>'
      +label+': '+count+'</div>'
    ).join('');
    return '<div style="display:flex;align-items:center;gap:0.75rem;flex:0 0 auto;">'
      +'<svg viewBox="0 0 140 140" width="100" height="100">'+paths+'</svg>'
      +'<div>'+legend+'</div></div>';
  }

  const genderColors = { F:'#f9a8d4', M:'#93c5fd', U:'#334155' };
  const genderCounts = { Female:orgGender.F, Male:orgGender.M };
  if (orgGender.U > 0) genderCounts['Unknown'] = orgGender.U;
  const genderColorsMap = { Female:'#f9a8d4', Male:'#93c5fd', Unknown:'#334155' };
  const maritalColors2 = { Married:'#6d28d9',Single:'#0ea5e9',Engaged:'#f97316',Widowed:'#94a3b8',Divorced:'#ef4444',Separated:'#fbbf24',Unknown:'#334155' };

  const knownAgeExecCount = Object.values(orgAgeCount).reduce((a,b)=>a+b,0);
  const unknownAgeExecCount = seenPersonIds.size - knownAgeExecCount;
  const ageKeys = ['<20','20–24','25–29','30–34','35–39','40–44','45–49','50–54','55+','Unknown'];
  orgAgeCount['Unknown'] = unknownAgeExecCount; // always add, even if 0
  const ageMax = Math.max(...Object.values(orgAgeCount), 1);
  const ageBarW=280, ageBarH=120, aPL=25, aPR=8, aPT=12, aPB=28;
  const aPlotW=ageBarW-aPL-aPR, aPlotH=ageBarH-aPT-aPB;
  const abw=Math.floor(aPlotW/ageKeys.length), agap=2;
  const ageBars = ageKeys.map((key,i) => {
    const count=orgAgeCount[key]||0;
    const bh=count>0?Math.max(3,Math.round((count/ageMax)*aPlotH)):0;
    const x=aPL+i*abw+agap, y=aPT+aPlotH-bh, lx=aPL+i*abw+abw/2;
    return (count>0?'<rect x="'+x+'" y="'+y+'" width="'+(abw-agap*2)+'" height="'+bh+'" fill="'+(key==='Unknown'?'#ef4444':'#3b82f6')+'" rx="2" opacity="0.85"><title>'+key+': '+count+'</title></rect>'
      +'<text x="'+lx+'" y="'+(y-2)+'" text-anchor="middle" fill="#94a3b8" font-size="8">'+count+'</text>':'')
      +'<text x="'+lx+'" y="'+(ageBarH-4)+'" text-anchor="middle" fill="#94a3b8" font-size="7">'+key+'</text>';
  }).join('');
  const ageBarSVG = '<div style="flex:0 0 auto;"><div style="font-size:0.72rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.25rem;">Age Distribution</div>'
    +'<svg viewBox="0 0 '+ageBarW+' '+ageBarH+'" width="'+ageBarW+'" height="'+ageBarH+'">'+ageBars+'</svg></div>';

  const genderPieExec  = buildExecPie(genderCounts, genderColorsMap);
  const knownMaritalExec = Object.entries(orgMarital).filter(([k]) => k !== "Unknown").reduce((s,[,c]) => s+c, 0);
  const maritalPieExec = knownMaritalExec > 0 ? buildExecPie(orgMarital, maritalColors2) : null;
  const hasDemo = seenPersonIds.size > 0;
  const demoPanelHTML = hasDemo ? '<div class="exec-panel exec-panel--collapsible open" id="demo-panel">'
    +'<button type="button" class="exec-panel__toggle" onclick="this.closest(&quot;.exec-panel--collapsible&quot;).classList.toggle(&quot;open&quot;)" aria-expanded="true">'
    +'<span class="exec-panel__title">👥 Team Demographics</span>'
    +'<span class="exec-panel__chevron">▸</span>'
    +'</button>'
    +'<div class="exec-panel__body">'
    +'<div style="display:flex;flex-wrap:wrap;gap:1.5rem;align-items:flex-start;">'
    +(genderPieExec  ? '<div><div style="font-size:0.72rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.5rem;">Gender</div>'+genderPieExec+'</div>' : '')
    +ageBarSVG
    +(maritalPieExec ? '<div><div style="font-size:0.72rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.5rem;">Marital Status</div>'+maritalPieExec+'</div>' : '')
    +((multiTeamHTML || loginExecHTML) ? '<div style="margin-top:1rem;padding-top:1rem;border-top:1px solid #334155;width:100%;">' 
      + '<div style="font-size:0.72rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.75rem;">Team Statistics</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:1.5rem;align-items:flex-start;">' + multiTeamHTML + loginExecHTML + '</div></div>' : '')
    +'</div></div></div>' : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${ORG.name} — PCO Reports</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="title-bar">
    <h1>${ORG.icon} ${ORG.name} — PCO Reports</h1>
    <button type="button" id="theme-toggle" title="Toggle light/dark mode">🌙</button>
    <button type="button" id="help-btn" title="Help">?</button>
  </div>
  <p class="subtitle">Select a team to view their scheduling report</p>
  ${execOccasionsHTML}
  ${demoPanelHTML}
  ${servicesGrid}
  <h2 class="section-heading">Teams</h2>
  <div class="teams-grid">${teamCards.join("")}</div>
  <footer>
    ${ORG.name} · Data cached from Planning Center · Refreshes every ${FULL_TTL_SEC / 60} minutes
    · <a href="/?refresh=${REFRESH_KEY}">Force refresh all</a>
    ${userEmail ? `<br>Generated for ${escapeHtml(userEmail)}` : ''}
  </footer>
  <div id="help-overlay"></div>
  <div id="help-modal" role="dialog" aria-modal="true" aria-label="Help">
    <div class="help-header">
      <h2>${ORG.icon} ${ORG.name} — Help</h2>
      <button type="button" id="help-close" aria-label="Close help">&#x2715;</button>
    </div>
    <div class="help-body">

      <h3>Team Cards</h3>
      <p>Each card shows a summary for one team pulled from the Planning Center cache. Click any card to open the full team report.</p>
      <table class="help-table">
        <tr><td><strong>Members</strong></td><td>Total permanent team members from the PCO team roster.</td></tr>
        <tr><td><strong>Confirmed %</strong></td><td>Average per-person confirmation rate across all plans in the window. <span style="color:var(--green)">Green</span> ≥${ORG.pctThresholds && ORG.pctThresholds.high || 70}%, <span style="color:var(--yellow)">yellow</span> ≥${ORG.pctThresholds && ORG.pctThresholds.medium || 40}%, <span style="color:var(--red)">red</span> below that.</td></tr>
        <tr><td><strong>Next X/Y</strong></td><td>Confirmed / rostered headcount for the next upcoming service date.</td></tr>
        <tr><td><strong>Refreshed</strong></td><td>How long ago the data was fetched from Planning Center.</td></tr>
      </table>

      <h3>Upcoming Services Grid</h3>
      <p>Shows confirmed/rostered counts per team for the next ${ORG.upcomingDatesCount || 4} upcoming service dates. The <strong>All Teams</strong> row totals across every team. Colour coding matches the team cards. A 📝 badge indicates the plan has a title or series set in PCO — hover to see the note. A ✉️ badge means unsent notifications exist for that service.</p>
      <p>Click the panel header to expand the per-team breakdown rows.</p>
      <h3>Data &amp; Refresh</h3>
      <p>Data is fetched from Planning Center and cached for ${FULL_TTL_SEC / 60} minutes. The cache pre-warms automatically before expiry so reports are always fast to load.</p>
      <p>To force an immediate refresh of all teams, use the <a href="/?refresh=${REFRESH_KEY}" style="color:var(--accent)">Force refresh all</a> link in the footer. To refresh a single team, open that team's report and add <code>?refresh=${REFRESH_KEY}</code> to the URL.</p>

      <h3>Adding Teams</h3>
      <p>New teams are added by editing <code>src/teams.js</code>. Each team needs a <code>slug</code>, <code>label</code>, <code>icon</code>, <code>filterFn</code>, and optionally <code>roles</code>, <code>trackAttendance</code>, and <code>thresholds</code>.</p>

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
    (function() {
      const btn     = document.getElementById('help-btn');
      const modal   = document.getElementById('help-modal');
      const overlay = document.getElementById('help-overlay');
      const close   = document.getElementById('help-close');
      function open()  { modal.classList.add('open'); overlay.classList.add('open'); close.focus(); }
      function shut()  { modal.classList.remove('open'); overlay.classList.remove('open'); btn.focus(); }
      btn.addEventListener('click', open);
      close.addEventListener('click', shut);
      overlay.addEventListener('click', shut);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') shut(); });
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Loading page — shown while /team/:slug/report is fetching
// ---------------------------------------------------------------------------
function loadingPage(teamSlug, teamLabel, teamIcon) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${ORG.name} — ${teamLabel}</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="stylesheet" href="/style.css">
  <style>body { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2rem; }</style>
</head>
<body>
  <a href="/" class="back">← All Teams</a>
  <h1>${teamIcon} ${ORG.name} — ${teamLabel}</h1>
  <div class="spinner"></div>
  <div class="steps">
    <div class="step active" id="s1"><span class="step-dot"></span>Fetching service types &amp; teams</div>
    <div class="step"        id="s2"><span class="step-dot"></span>Loading plans &amp; rosters</div>
    <div class="step"        id="s3"><span class="step-dot"></span>Fetching attendance records</div>
    <div class="step"        id="s4"><span class="step-dot"></span>Loading blockout dates</div>
    <div class="step"        id="s5"><span class="step-dot"></span>Fetching member profiles</div>
    <div class="step"        id="s6"><span class="step-dot"></span>Rendering report</div>
  </div>
  <div class="elapsed" id="elapsed">0s</div>
  <script>
    const steps=['s1','s2','s3','s4','s5','s6'], start=Date.now();
    const stepTimes=[2000,6000,12000,18000,22000,25000];
    function tick(){
      const e=Date.now()-start;
      document.getElementById('elapsed').textContent=(e/1000).toFixed(0)+'s';
      const n=stepTimes.findIndex(t=>e<t), a=n===-1?steps.length-1:n;
      steps.forEach((id,i)=>{ document.getElementById(id).className='step'+(i<a?' done':i===a?' active':''); });
    }
    const iv=setInterval(tick,500);
    fetch('/team/${teamSlug}/report'+window.location.search)
      .then(r=>r.text())
      .then(html=>{ clearInterval(iv); document.open(); document.write(html); document.close(); })
      .catch(err=>{ clearInterval(iv); document.body.innerHTML='<p style="color:#ef4444;padding:2rem">Error: '+err.message+'</p>'; });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    try {
      const url          = new URL(request.url);
      const forceRefresh = url.searchParams.get("refresh") === REFRESH_KEY;
      const path         = url.pathname;
      const userEmail    = request.headers.get("CF-Access-Authenticated-User-Email") || null;

      // GET / — executive summary
      if (path === "/" || path === "") {
        const html = await renderExecSummary(env, userEmail);
        return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }

      // GET /team/:slug — team detail (serve from R2 if warm, else loading page)
      const teamMatch = path.match(/^\/team\/([^/]+)$/);
      if (teamMatch) {
        const teamSlug   = teamMatch[1];
        const teamConfig = getTeam(teamSlug);
        if (!teamConfig) return new Response("Team not found", { status: 404 });

        if (!forceRefresh) {
          const r2Key  = `${ORG.r2Prefix}/${teamSlug}/data.json`;
          const cached = await readR2(env, r2Key);
          if (cached) {
            const data = deserializeData(JSON.parse(cached.text));
            data.userEmail = userEmail;
            const html = renderHTML(data, detectDevice(request));
            const ageMs  = cached.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : 0;
            const maxAge = Math.max(0, Math.floor((FULL_TTL_SEC * 1000 - ageMs) / 1000));
            return new Response(html, {
              headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "Cache-Control": "public, max-age=" + maxAge,
              },
            });
          }
        }

        return new Response(loadingPage(teamSlug, teamConfig.label, teamConfig.icon), {
          headers: { "Content-Type": "text/html;charset=UTF-8" },
        });
      }

      // GET /team/:slug/report — fetch via DO, return rendered HTML
      const reportMatch = path.match(/^\/team\/([^/]+)\/report$/);
      if (reportMatch) {
        const teamSlug   = reportMatch[1];
        const teamConfig = getTeam(teamSlug);
        if (!teamConfig) return new Response("Team not found", { status: 404 });

        const doId   = env.PCO_DATA_CACHE.idFromName(teamSlug);
        const doStub = env.PCO_DATA_CACHE.get(doId);
        const doUrl  = new URL("https://do/?team=" + teamSlug + (forceRefresh ? "&refresh=" + REFRESH_KEY : ""));
        const doResp = await doStub.fetch(doUrl.toString());

        if (!doResp.ok) throw new Error("DO fetch failed: " + doResp.status);

        const data = deserializeData(JSON.parse(await doResp.text()));
        data.userEmail = userEmail;
        const html = renderHTML(data, detectDevice(request));
        return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return new Response("Error: " + err.message + "\n" + err.stack, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },
};