# Product Requirements Document
## PCO Services Dashboard
**Version:** 1.0  
**Date:** April 2026  
**Status:** Production

---

## 1. Overview

PCO Services Dashboard is a Cloudflare Workers-based web application that fetches scheduling, attendance, and member data from Planning Center Online (PCO) and renders rich, interactive HTML reports for each ministry team. The application provides church team leaders and schedulers with real-time visibility into roster confirmation rates, attendance trends, member demographics, and upcoming scheduling obligations.

---

## 2. Problem Statement

Planning Center Online provides powerful scheduling tools but its native reporting is limited — it does not offer cross-team summaries, trend analysis, or at-a-glance dashboards for leadership. Choir conductors, team directors, and creative leaders must navigate multiple PCO pages to understand how their teams are tracking across services. There is no single view showing confirmation rates, attendance history, response times, blockout conflicts, and upcoming occasions together.

---

## 3. Goals

- Provide a single URL that loads a complete team scheduling report with no login required
- Aggregate data from multiple service types (8am, 10am, 6pm) into one unified view
- Surface patterns not visible in PCO natively: consecutive declines, chronic no-shows, slow responders
- Show upcoming service headcounts to help schedulers take action before services happen
- Support multiple teams from the same Cloudflare Worker with zero code changes per team
- Cache data efficiently to minimise PCO API calls and ensure fast page loads

---

## 4. Users

**Primary:** Choir conductors and directors — use the team report daily to monitor roster confirmations and prepare for upcoming services.

**Secondary:** Creative team leaders — use the executive summary to see cross-team headcounts and upcoming occasions.

**Tertiary:** Schedulers — use the notification backlog to identify and follow up with unconfirmed members.

---

## 5. Features

### 5.1 Executive Summary (`/`)

A dashboard page aggregating cached data from all configured teams.

- **Team cards** — one card per team showing member count, avg confirmation %, confirmed/rostered for the next service, and cache age. Clicking opens the team report.
- **Birthdays & anniversaries panel** — upcoming birthdays and anniversaries for this week and next week, deduplicated across teams.
- **Demographics panel** — org-wide gender pie, marital status pie, and age distribution bar chart aggregated across all teams.
- **Upcoming services grid** — confirmed/rostered per team per date for the next four Sundays, with an "All Teams" total row. Collapsible to show only totals. Plan notes (series/title) shown as 📝 badge.
- **Notification backlog** — upcoming services within two weeks where notifications have been sent but not responded to, or where rostered members haven't been notified yet. Collapsible.
- **Help modal** — covers all panels, refresh mechanics, and adding new teams.

### 5.2 Team Report (`/team/:slug`)

A detailed report for a single team.

**Summary cards:** Total members, Avg Confirmed %, Avg Attendance % (if tracked), Avg Response Time.

**Upcoming services panel** — next 4 service dates with confirmed/pending/declined/unsent counts per service time.

**Response time distribution** — bar chart bucketed by how quickly members respond to notifications (same day, 1d, 2d, 3–7d, 8+d).

**Charts row:**
- Gender pie chart (clickable — filters table to that gender)
- Marital status pie chart (clickable — filters table to that marital status, hidden if no data)
- Age distribution bar chart (buckets: <20, 20–24, 25–29, 30–34, 35–39, 40–44, 45–49, 50–54, 55+)
- Attendance line chart with dotted average line (shown only if `trackAttendance: true`)

**Birthdays & anniversaries panel** — this week and next week for the team.

**Roster table:**
- Member name with avatar, gender colour coding, role badges, warn badges
- Confirmed %, Attend % (optional), Response Time columns — each toggleable via pill buttons with URL state serialisation
- One column per plan in the 4-month window (2 months past, 2 months future)
- Status cells: ✅ Confirmed, ❌ Declined (with hover reason), ⏳ Unconfirmed (sent), ✉️ Unsent, · Not scheduled, 🚫 Blocked out
- Blockout + auto-decline: shows blockout pattern only (PCO auto-declines when a blockout is entered)
- Row highlights: red = N+ consecutive declines, yellow = N+ confirmed no-shows (thresholds configurable)
- Sortable columns, name filter, role filter buttons
- Column visibility toggles with URL parameter persistence

**Loading page** — shown on cache miss with animated step indicators and elapsed timer.

**Help modal** — comprehensive reference for all icons, filters, highlights, and features.

### 5.3 Multi-Team Architecture

- Each team is defined in `teams.js` with a slug, label, icon, PCO filter function, optional role definitions, and optional overrides for attendance tracking and highlight thresholds.
- Adding a new team requires only adding an entry to `teams.js` — no changes to `index.js` or `shared.js`.
- Each team gets its own Durable Object instance and R2 cache key.

### 5.4 Caching & Performance

- Data is cached in Cloudflare R2 with a 30-minute TTL (configurable in `config.js`).
- A Durable Object per team coordinates fetch locking (prevents concurrent PCO fetches) and alarm-based pre-warming (cache is refreshed 5 minutes before expiry so users never hit a cold cache after first load).
- On cache hit at `/team/:slug`, the Worker reads from R2 and renders HTML directly — no Durable Object hop, no PCO call.
- Force refresh available via `?refresh={refreshKey}` (configurable in `config.js`).

### 5.5 Specialist Roles

- Each team can define specialist role badges (e.g. Conductor, Director, Section Leaders).
- Roles are defined per team in `teams.js` with key, label, colour, and PCO position name matching terms.
- Training variants are detected and shown with muted colours.
- Role filter buttons appear in the filter bar; clicking filters the table to members with that role.
- Role membership is determined from permanent team membership (not just recent rostering).

### 5.6 Demographics

Data collected from the PCO People API (no extra API calls beyond the existing batch fetch):
- Gender (M/F/Unknown)
- Marital status (Married, Single, Engaged, Widowed, Divorced, Separated)
- Birthdate (used for age distribution and upcoming birthdays)
- Anniversary date (used for upcoming anniversaries)

---

## 6. Non-Goals

- This application does not write to Planning Center — it is read-only.
- It does not send notifications or emails.
- It does not support login/authentication beyond the `?refresh=` secret key.
- It does not support non-PCO scheduling systems.

---

## 7. Technical Architecture

```
Browser
  │
  ├── GET /                    → Cloudflare Worker (index.js)
  │                               → R2 read (all teams)
  │                               → renderExecSummary()
  │
  ├── GET /team/:slug          → Worker
  │                               → R2 read (if warm) → renderHTML()
  │                               → Loading page (if cold)
  │
  └── GET /team/:slug/report   → Worker
                                  → PCODataCache DO (per-team)
                                  │   → R2 read (if fresh)
                                  │   → fetchTeamData() → PCO API (if stale)
                                  │   → R2 write
                                  └── renderHTML()

PCO APIs used:
  - services/v2/folders/{id}/service_types
  - services/v2/service_types/{id}/teams
  - services/v2/teams/{id}/person_team_position_assignments
  - services/v2/teams/{id}/team_positions
  - services/v2/service_types/{id}/plans
  - services/v2/service_types/{id}/plans/{id}/team_members
  - services/v2/service_types/{id}/plans/{id}/attendances
  - services/v2/people/{id}/blockouts
  - people/v2/people?where[id]=...
```

### Key Files

| File | Purpose |
|---|---|
| `src/index.js` | Cloudflare Worker entry point. Routing, DO class, serialization, exec summary, loading page. |
| `src/shared.js` | All PCO fetch logic and HTML rendering. Used by both Worker and local server. |
| `src/teams.js` | Team registry. Add new teams here. |
| `src/config.js` | Org-specific configuration (name, folder ID, R2 prefix, TTLs, thresholds). |
| `src/public/style.css` | All CSS, served as a static asset by Cloudflare. |
| `local-server.js` | Node.js dev server mirroring Worker behaviour. |
| `wrangler.toml` | Cloudflare Worker, R2, and Durable Object configuration. |

---

## 8. Configuration

All org-specific values live in `src/config.js`. No other file needs editing to deploy for a new organisation.

| Setting | Description |
|---|---|
| `name` | Organisation display name |
| `icon` | Emoji for the exec summary heading |
| `folderId` | PCO folder ID containing service types |
| `r2Prefix` | R2 key namespace (should match bucket name) |
| `refreshKey` | Secret query param for force refresh |
| `thresholds.consecutiveDeclines` | Consecutive decline streak before red highlight |
| `thresholds.confirmedNoShows` | Consecutive no-show streak before yellow highlight |
| `ttl.*` | Cache TTLs in seconds per data layer |

Team-level settings in `src/teams.js` can override `thresholds` per team.

---

## 9. Constraints & Assumptions

- Requires a Cloudflare Workers Paid plan for Durable Objects ($5/month minimum).
- Requires a PCO API key with at minimum Services-level read access. People API data (gender, marital status, birthdate, anniversary) requires People-level access.
- PCO API is rate-limited; the application respects `Retry-After` headers and batches blockout fetches in groups of 5 with 300ms delays.
- The application is read-only — no PCO data is modified.
- All data is cached and may be up to 30 minutes stale.