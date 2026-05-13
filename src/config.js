// Organisation configuration — edit this file to deploy for a different organisation.
// See README for a full list of configurable fields.

export const ORG = {
  // Display name used in page titles and headings
  name: "Insert ChurchName Here",

  // Emoji icon used on the exec summary page
  icon: "⛪",

  // IANA timezone for the organisation — used to decide whether a service date
  // is "today" or "past" so attendance data is fetched at the right time.
  timezone: "Australia/Sydney",

  // BCP-47 locale for date formatting (e.g. "en-AU", "en-US", "en-GB")
  locale: "en-AU",

  // Default team slug shown when no ?team= param is provided to the DO
  defaultTeam: "muppet-choir",

  // Week start day for birthday/anniversary grouping (0 = Sunday, 1 = Monday, …)
  weekStartDay: 0,

  // PCO folder ID that contains the relevant service types
  // Find this in the PCO URL when browsing folders: /services/v2/folders/{id}
  folderId: "Insert your folderID here",

  // R2 key prefix — should match the bucket binding in wrangler.toml
  // All team data is stored under: {r2Prefix}/{teamSlug}/data.json
  r2Prefix: "pco-services-dashboard-cache",

  // Secret query param to force a cache refresh: ?refresh={refreshKey}
  refreshKey: "xyzzy",

  // Row highlight thresholds
  // Members are flagged when they hit or exceed these consecutive counts.
  thresholds: {
    consecutiveDeclines: 3,  // consecutive non-blockout declines before red highlight
    confirmedNoShows:    3,  // consecutive confirmed-but-absent before yellow highlight
  },

  // Plan window — how far back and forward to fetch plans from PCO
  window: {
    pastMonths:   2,  // months of past plans to fetch and display
    futureMonths: 3,  // months of future plans to fetch and display
  },

  // Confirmation % colour thresholds (used in table cells and team cards)
  // Percentages at or above 'high' show green; at or above 'medium' show yellow; below show red.
  pctThresholds: {
    high:   70,  // green
    medium: 40,  // yellow
  },

  // Response time colour thresholds (days)
  // Below 'fast' = green; below 'ok' = yellow; at or above 'ok' = red.
  responseTime: {
    fast: 1,  // days — green if avg response < this
    ok:   3,  // days — yellow if avg response < this; red if >= this
  },

  // Upcoming services panel — how many distinct service dates to show
  upcomingDatesCount: 4,

  // New member flag — members added to a team within this many days are badged as "New"
  newMemberDays: 30,

  // Notification backlog — how many days ahead to scan for unconfirmed members
  backlogWindowDays: 14,

  // Last-login recency buckets — label + day boundaries for the login chart.
  // min/max are inclusive day counts.  Use -1/-1 for the "never logged in" bucket.
  loginBuckets: [
    { label: "<7d",    min: 0,  max: 7   },
    { label: "8\u201314d",  min: 8,  max: 14  },
    { label: "15\u201321d", min: 15, max: 21  },
    { label: ">21d",    min: 22, max: Infinity },
    { label: "Never",   min: -1, max: -1 },
  ],

  // PCO API batch sizes and rate-limit tuning
  api: {
    blockoutBatchSize:  5,    // people fetched per blockout batch
    blockoutBatchDelay: 300,  // ms delay between blockout batches
    peopleBatchSize:    100,  // people fetched per People API batch
  },

  // Cache TTLs in seconds — how long each data layer is cached before refresh.
  // The full payload TTL governs how often users see fresh data.
  // Alarm pre-warming fires {prewarmLeadSec} seconds before the full TTL expires.
  ttl: {
    teamMembers:    24 * 3600,  // team membership + positions: daily
    plans:           4 * 3600,  // plan list + dates: every 4 hours
    rosters:         1 * 3600,  // roster statuses + attendance: hourly
    blockouts:            1800, // blockout dates: every 30 min (governs full TTL)
    prewarmLeadSec:        300, // alarm fires this many seconds before expiry
  },
};
