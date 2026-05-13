# PCO Team Report

A Cloudflare Workers application that fetches data from Planning Center Online and renders interactive scheduling and demographic reports for ministry teams.

## Features

### Executive Summary (`/`)
- **Team cards** — at-a-glance stats for every team, sorted alphabetically
- **Upcoming services grid** — cross-team roster overview for the next several service dates
- **Notification backlog** — unconfirmed members within the next N days
- **Team demographics** (collapsible) — org-wide gender, marital status, and age distribution charts
- **Team overlap chart** — shows members serving on 2+ teams (parent/child teams are collapsed into one group)
- **Consolidated last-login chart** — login recency across all team members, deduplicated
- **Birthdays & anniversaries** — this week and next week, with a collapsible "not rostered" section

### Team Report (`/team/:slug`)
- **Summary stats** — total members, confirmation %, attendance %, response time
- **Roster table** — full member grid with status icons, blockout crosshatch, role badges, and click-to-filter
- **Charts** — gender, marital status, age distribution, login recency (all clickable to filter the table)
- **Upcoming service headcounts** — next N service dates with confirmed/total counts
- **Response time distribution** — histogram of how quickly members confirm
- **Birthdays & anniversaries panel** — this week and next week
- **Specialist roles** — colour-coded badges (full and training variants) matched from PCO positions
- **Blockout overlay** — crosshatch pattern on blocked-out dates, prioritised over decline icons
- **Highlight rows** — consecutive declines (red) and confirmed no-shows (yellow)
- **New member badge** — flags members added within a configurable number of days

### Loading page
Shown on a cache miss while data is fetched from PCO. Features an animated step indicator and elapsed timer.

---

## Project structure

```
├── src/
│   ├── index.js          — Cloudflare Worker entry point, routing & exec summary
│   ├── shared.js         — PCO data fetching & team report HTML rendering
│   ├── teams.js          — Team registry (add/edit teams here)
│   ├── config.js         — Organisation configuration (all tunables)
│   └── public/
│       ├── style.css     — Stylesheet (served as static asset)
│       └── favicon.png   — Favicon
├── local-server.js       — Node.js development server (no Cloudflare required)
├── wrangler.toml         — Cloudflare deployment configuration
├── .dev.vars             — Local-only PCO credentials (git-ignored)
├── .gitignore            — Excludes .dev.vars, node_modules, .wrangler
├── PRD.md                — Product Requirements Document
├── README.md             — This file
└── INSTALL.md            — Full installation & deployment guide
```

---

## Key concepts

### Teams
Each team is defined in `src/teams.js` with:
- **slug** — URL identifier (e.g. `vocals` → `/team/vocals`)
- **label** — display name
- **icon** — emoji for headings and nav
- **filterFn** — matches the team name within PCO service types
- **roles** — specialist role definitions with colour and substring matching rules
- **trackAttendance** — whether attendance is recorded for this team in PCO
- **parentTeam** — optional slug of a parent team; members in both parent and child are treated as one team for overlap counting
- **thresholds** — optional per-team overrides for decline/no-show highlight counts

### Parent/child teams
A team can declare `parentTeam: "parent-slug"` to indicate it is a sub-team. In the executive summary's team overlap chart, a person on both the parent and child counts as **one group**, not two. The tooltip shows the relationship as `Parent/Child` (e.g. "Vocals/Adult Choir, Catering").

### Caching
Data flows through two layers:
1. **Cloudflare R2** — JSON payload stored per team, TTL tracked via metadata
2. **Durable Object** — one instance per team, coordinates fetch locking and alarm-based pre-warming

A Durable Object alarm fires before the cache TTL expires and silently refreshes the data in the background. Users always get a fast response.

### Specialist roles
Roles are matched against PCO `team_position_name` values using substring rules defined in `teams.js`. Full roles show in solid colours; training variants show in muted colours. Role badges appear beside member names in the table and can be clicked to filter.

### Blockout handling
If a member has a PCO blockout on a plan date, the cell shows a crosshatch pattern regardless of their roster status. If PCO auto-declines them due to a blockout, the blockout display takes priority over the decline icon.

---

## Configuration

Edit `src/config.js` to deploy for a different organisation. All values are documented inline.

```js
export const ORG = {
  name:       "Your Organisation",
  icon:       "⛪",
  timezone:   "Australia/Sydney",      // IANA timezone
  locale:     "en-AU",                 // BCP-47 locale for date formatting
  defaultTeam: "adult-choir",          // default team when no ?team= param
  weekStartDay: 0,                     // 0=Sunday, 1=Monday, …
  folderId:   "YOUR_PCO_FOLDER_ID",
  r2Prefix:   "your-org-pco-cache",
  refreshKey: "your-secret-key",
  thresholds: { consecutiveDeclines: 3, confirmedNoShows: 3 },
  pctThresholds: { high: 70, medium: 40 },
  responseTime:  { fast: 1, ok: 3 },
  window: { pastMonths: 2, futureMonths: 3 },
  upcomingDatesCount: 4,
  newMemberDays: 30,
  backlogWindowDays: 14,
  loginBuckets: [
    { label: "<7d",  min: 0, max: 7 },
    { label: "8–14d",  min: 8, max: 14 },
    { label: "15–21d", min: 15, max: 21 },
    { label: ">21d",   min: 22, max: Infinity },
    { label: "Never",  min: -1, max: -1 },
  ],
  api: { blockoutBatchSize: 5, blockoutBatchDelay: 300, peopleBatchSize: 100 },
  ttl: {
    teamMembers: 24 * 3600,
    plans:        4 * 3600,
    rosters:      1 * 3600,
    blockouts:         1800,
    prewarmLeadSec:     300,
  },
};
```

---

## Local development

```bash
node local-server.js
```

Opens at `http://localhost:8787`. Uses in-memory caching. Supports all routes (`/`, `/team/:slug`, `/team/:slug/report`).

Force a fresh fetch from PCO:
```
http://localhost:8787/team/adult-choir?refresh=your-secret-key
```

---

## Deployment

```bash
npx wrangler deploy
```

See `INSTALL.md` for full setup including PCO API credentials, R2 bucket, and Durable Objects.

---

## Forcing a cache refresh in production

Add `?refresh={refreshKey}` to any URL where `refreshKey` matches the value in `config.js`:

```
https://your-worker.workers.dev/?refresh=your-key
https://your-worker.workers.dev/team/adult-choir?refresh=your-key
```

---

## Adding a new team

Edit `src/teams.js` and add an entry to the `TEAMS` array:

```js
{
  slug: "band",
  label: "Sunday Band",
  icon: "🎸",
  folderIds: [ORG.folderId],
  filterFn: (name) => name.includes("band"),
  trackAttendance: false,
  roles: [],
}
```

To make it a sub-team of an existing team, add `parentTeam: "parent-slug"`.

No other files need to be changed. Deploy and the new team will appear on the executive summary.