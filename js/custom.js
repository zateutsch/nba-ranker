// Custom player-group filters: "at least N <award> between <year> and <year>",
// combined with optional extra filters. Configs are plain JSON so they can be
// saved with a ranking session.

export const AWARDS = [
  { key: "allStar", one: "All-Star selection", many: "All-Star selections", group: "Selections" },
  { key: "allNba", one: "All-NBA team (any)", many: "All-NBA teams (any)", group: "Selections" },
  { key: "allNba1", one: "All-NBA 1st Team", many: "All-NBA 1st Teams", group: "Selections" },
  { key: "allNba2", one: "All-NBA 2nd Team", many: "All-NBA 2nd Teams", group: "Selections" },
  { key: "allNba3", one: "All-NBA 3rd Team", many: "All-NBA 3rd Teams", group: "Selections" },
  { key: "allDefensive", one: "All-Defensive team (any)", many: "All-Defensive teams (any)", group: "Selections" },
  { key: "allDefensive1", one: "All-Defensive 1st Team", many: "All-Defensive 1st Teams", group: "Selections" },
  { key: "allRookie", one: "All-Rookie team", many: "All-Rookie teams", group: "Selections" },
  { key: "championships", one: "championship", many: "championships", group: "Awards" },
  { key: "mvp", one: "MVP", many: "MVPs", group: "Awards" },
  { key: "finalsMvp", one: "Finals MVP", many: "Finals MVPs", group: "Awards" },
  { key: "dpoy", one: "Defensive Player of the Year", many: "Defensive Player of the Year awards", group: "Awards" },
  { key: "roy", one: "Rookie of the Year", many: "Rookie of the Year awards", group: "Awards" },
  { key: "sixthMan", one: "Sixth Man of the Year", many: "Sixth Man awards", group: "Awards" },
  { key: "mip", one: "Most Improved Player", many: "Most Improved awards", group: "Awards" },
  { key: "allStarMvp", one: "All-Star Game MVP", many: "All-Star Game MVPs", group: "Awards" },
  { key: "conferenceFinalsMvp", one: "Conference Finals MVP", many: "Conference Finals MVPs", group: "Awards" },
  { key: "olympicGold", one: "Olympic gold medal", many: "Olympic gold medals", group: "Awards" },
];

const awardByKey = new Map(AWARDS.map((a) => [a.key, a]));

export const POSITIONS = ["Guard", "Forward", "Center"];

export const defaultRule = () => ({ award: "allStar", min: 1 });

// from/to apply to every rule; null means no bound.
export const defaultFilter = () => ({
  rules: [defaultRule()],
  from: null,
  to: null,
  status: "any",
  positions: [],
});

export const EXAMPLES = [
  { label: "5+ All-Stars", filter: { rules: [{ award: "allStar", min: 5 }] } },
  { label: "3+ All-Stars since 2015", filter: { rules: [{ award: "allStar", min: 3 }], from: 2015 } },
  { label: "2+ All-NBA since 2010", filter: { rules: [{ award: "allNba", min: 2 }], from: 2010 } },
  { label: "1st Team All-NBA since 2000", filter: { rules: [{ award: "allNba1", min: 1 }], from: 2000 } },
  { label: "Finals MVPs", filter: { rules: [{ award: "finalsMvp", min: 1 }] } },
  {
    label: "Two-way stars",
    filter: { rules: [{ award: "allNba", min: 1 }, { award: "allDefensive1", min: 1 }] },
  },
  { label: "'90s icons", filter: { rules: [{ award: "allStar", min: 3 }], from: 1990, to: 1999 } },
  { label: "Active, 3+ All-NBA", filter: { rules: [{ award: "allNba", min: 3 }], status: "active" } },
];

export const withDefaults = (f) => {
  const base = defaultFilter();
  const rules = f.rules ?? base.rules;
  // Older saved filters kept years on each rule; carry the first rule's range over.
  const legacy = rules.find((r) => r.from || r.to) ?? {};
  return {
    rules: rules.map((r) => ({ award: r.award ?? "allStar", min: r.min ?? 1 })),
    from: f.from ?? legacy.from ?? null,
    to: f.to ?? legacy.to ?? null,
    status: f.status ?? base.status,
    positions: f.positions ?? base.positions,
  };
};

// "2006-07" -> 2007: seasons are identified by the year they end in (the All-Star Game year).
const seasonYear = (season) => Number(season.slice(0, 4)) + 1;

function countAward(p, award, from, to) {
  const a = p.accolades;
  if (!from && !to && award in a) return a[award];
  const seasons = a.seasons[award] ?? [];
  return seasons.filter((s) => {
    const y = seasonYear(s);
    return (!from || y >= from) && (!to || y <= to);
  }).length;
}

export function matches(p, f) {
  if (!f.rules.every((r) => countAward(p, r.award, f.from, f.to) >= Math.max(1, r.min || 1))) return false;
  if (f.status === "active" && !p.active) return false;
  if (f.status === "retired" && p.active) return false;
  if (f.positions.length && !f.positions.some((pos) => (p.position || "").includes(pos))) return false;
  return true;
}

function describeRule({ award, min }) {
  const a = awardByKey.get(award);
  const n = Math.max(1, min || 1);
  return n === 1 ? `${n}+ ${a.one}` : `${n}+ ${a.many}`;
}

function describeYears({ from, to }) {
  if (from && to) return from === to ? `in ${from}` : `${from}–${to}`;
  if (from) return `since ${from}`;
  if (to) return `through ${to}`;
  return "";
}

export function describe(f) {
  const rules = f.rules.map(describeRule).join(", ");
  const years = describeYears(f);
  const parts = [f.rules.length > 1 || !years ? rules : `${rules} ${years}`];
  if (f.rules.length > 1 && years) parts.push(years);
  if (f.status !== "any") parts.push(f.status);
  if (f.positions.length) parts.push(f.positions.map((p) => `${p}s`).join("/"));
  return parts.filter(Boolean).join(" · ");
}