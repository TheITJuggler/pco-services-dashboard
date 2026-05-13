import { ORG } from "./config.js";

// ---------------------------------------------------------------------------
// Default roles — shared role definitions that teams can reference.
//
// Leave empty if you have no cross-team shared roles.
// Each role entry supports the following fields:
//   key              — single char identifier used in badges and filters
//   label            — full display name (e.g. "Conductor")
//   color            — badge background colour
//   textColor        — badge foreground colour (defaults to #fff if omitted)
//   trainingColor    — muted background for training variant of the role
//   trainingTextColor — foreground colour for training variant
//   fullTerms        — PCO position name substrings that match the full role
//   trainTerms       — PCO position name substrings that match a training variant.
//                     Set to [] if there is no training variant for this role.
//
// Example:
// export const DEFAULT_ROLES = [
//   {
//     key: "L", label: "Leader",
//     color: "#7c3aed", textColor: "#fff", trainingColor: "#4c1d95", trainingTextColor: "#a78bfa",
//     fullTerms:  ["leader"],
//     trainTerms: ["leader in training", "training leader"],
//   },
// ];
// ---------------------------------------------------------------------------
export const DEFAULT_ROLES = [];


// ---------------------------------------------------------------------------
// Team registry
// Each entry defines a team to be tracked. Add new teams here.
//
// Fields:
//   slug            — URL key and R2/DO cache identifier (e.g. "choir")
//   label           — Display name (e.g. "Adult Choir")
//   icon            — Emoji used in headings and nav
//   folderIds       — PCO folder IDs to search for service types
//   filterFn        — (teamName: string) => bool — matches relevant teams in PCO
//   roles           — Optional array of role definitions for this team.
//                     Omit or set to [] for teams with no specialist roles.
//                     Set trainTerms: [] on any role with no training variant.
//   trackAttendance — Whether this team records attendance in Planning Center.
//                     When false, the Attend % column and attendance icons are hidden.
//   parentTeam      — Optional: slug of the parent team. Members in both a parent
//                     and child team are treated as one team for overlap counting.
//                     e.g. parentTeam: "vocals" means Adult Choir is a sub-team.
//   thresholds      — Optional: override org-wide highlight thresholds for this team.
//                     { consecutiveDeclines: N, confirmedNoShows: N }
//                     Falls back to ORG.thresholds if omitted.
// ---------------------------------------------------------------------------
export const TEAMS = [
  {
    slug: "adult-choir",
    label: "Adult Choir",
    icon: "🎵",
    parentTeam: "vocals",
    folderIds: [ORG.folderId],
    filterFn: (name) => name.includes("choir") && !name.includes("youth"),
    trackAttendance: true,
    roles: [
      {
        key: "C", label: "Conductor",
        color: "#7c3aed", textColor: "#fff", trainingColor: "#4c1d95", trainingTextColor: "#a78bfa",
        fullTerms:  ["conductor"],
        trainTerms: ["conductor in training", "conductor training", "training conductor"],
      },
      {
        key: "D", label: "Director",
        color: "#0369a1", textColor: "#fff", trainingColor: "#0c4a6e", trainingTextColor: "#7dd3fc",
        fullTerms:  ["director"],
        trainTerms: ["director in training", "director training", "training director"],
      },
      {
        key: "A", label: "Alto Section Leader",
        color: "#b45309", textColor: "#fff", trainingColor: "#78350f", trainingTextColor: "#fcd34d",
        fullTerms:  ["alto"],
        trainTerms: [],
      },
      {
        key: "S", label: "Soprano Section Leader",
        color: "#0f766e", textColor: "#fff", trainingColor: "#134e4a", trainingTextColor: "#5eead4",
        fullTerms:  ["soprano"],
        trainTerms: [],
      },
      {
        key: "T", label: "Tenor Section Leader",
        color: "#be123c", textColor: "#fff", trainingColor: "#881337", trainingTextColor: "#fda4af",
        fullTerms:  ["tenor"],
        trainTerms: [],
      },
    ],
  },
  // Vocals
  {
    slug: "vocals",
    label: "Vocals",
    icon: "🎤",
    folderIds: [ORG.folderId],
    filterFn: (name) => name.includes("vocals"),
    trackAttendance: false,
    roles: [
      {
        key: "V", label: "Vocal Director",
        color: "#7c3aed", textColor: "#fff", trainingColor: "#4c1d95", trainingTextColor: "#a78bfa",
        fullTerms:  ["vocal director"],
        trainTerms: [],
      },
      {
        key: "F", label: "Frontline Vocal",
        color: "#0369a1", textColor: "#fff", trainingColor: "#0c4a6e", trainingTextColor: "#7dd3fc",
        fullTerms:  ["flv"],
        trainTerms: [],
      },
      {
        key: "B", label: "Backline Vocal",
        color: "#b45309", textColor: "#fff", trainingColor: "#78350f", trainingTextColor: "#fcd34d",
        fullTerms:  ["backline"],
        trainTerms: [],
      },
    ],
  },
// Musicians  
  {
    slug: "musicians",
    label: "Musicians",
    icon: "🎸",
    folderIds: [ORG.folderId],
    filterFn: (name) => name.includes("musicians"),
    trackAttendance: false,
    roles: [
      {
        key: "M", label: "Music Director",
        color: "#0369a1", textColor: "#fff", trainingColor: "#0c4a6e", trainingTextColor: "#7dd3fc",
        fullTerms:  ["md"],
        trainTerms: [], // no training variant
      },
    ],
  },
  // Worship Leaders
  {
    slug: "worship-leaders",
    label: "Worship Leaders",
    icon: "🎼",
    folderIds: [ORG.folderId],
    filterFn: (name) => name.includes("worship leaders"),
    trackAttendance: false,
    roles: [], // no specialist roles, or define your own above
  },
  
  //  slug: "band",
  //  label: "Sunday Band",
  //  icon: "🎸",
  //  folderIds: [ORG.folderId],
  //  filterFn: (name) => name.includes("band"),
  //  trackAttendance: false,
  //  roles: [], // no specialist roles, or define your own above
  //},
  //
  // Add future teams here, e.g.:
  //{
  //  slug: "band",
  //  label: "Sunday Band",
  //  icon: "🎸",
  //  folderIds: [ORG.folderId],
  //  filterFn: (name) => name.includes("band"),
  //  trackAttendance: false,
  //  roles: [], // no specialist roles, or define your own above
  //},
];

// Quick lookup by slug
export function getTeam(slug) {
  return TEAMS.find(t => t.slug === slug) || null;
}
