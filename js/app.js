import { runSort, maxPicks, shuffle, pairKey } from "./sorter.js";
import { AWARDS, POSITIONS, EXAMPLES, defaultRule, defaultFilter, withDefaults, matches, describe } from "./custom.js";
import { renderRankingImage } from "./share-image.js";

const TOP_K = 10;
const STORAGE_KEY = "nba-ranker:session";
const CUSTOM_KEY = "nba-ranker:custom";
const FIRST_YEAR = 1947;
const thisYear = new Date().getFullYear();

const SETS = [
  {
    id: "active-all-stars",
    name: "Active NBA All-Stars",
    description: "Current players with at least one All-Star selection",
    filter: (p) => p.active && p.accolades.allStar > 0,
  },
  {
    id: "mvps",
    name: "MVPs",
    description: "Every regular-season MVP winner, past and present",
    filter: (p) => p.accolades.mvp > 0,
  },
  {
    id: "top-75",
    name: "Top 75",
    description: "The NBA's 75th Anniversary Team",
    filter: (p) => p.greatest75,
  },
];

// "2025-26" is the 2026 All-Star Game. The id includes the year so a saved
// session never silently switches to a newer roster after a data refresh.
function addLatestAllStarSet() {
  const seasons = [...players.values()].flatMap((p) => p.accolades.seasons.allStar ?? []);
  if (!seasons.length) return;
  const latest = seasons.reduce((a, b) => (b > a ? b : a));
  const year = Number(latest.slice(0, 4)) + 1;
  SETS.splice(1, 0, {
    id: `all-stars-${year}`,
    name: `${year} NBA All-Stars`,
    description: `Everyone selected to the ${year} All-Star Game`,
    filter: (p) => (p.accolades.seasons.allStar ?? []).includes(latest),
  });
}

const app = document.getElementById("app");
let players = new Map();
let session = null; // { setId, filter?, mode, seed, answers: [{ a, b, winner }] }
let keyHandler = null;

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const customSet = (filter) => {
  const f = withDefaults(filter ?? {});
  return { id: "custom", custom: true, name: describe(f), filter: (p) => matches(p, f) };
};
const RANDOM_N = 10;
const RANDOM_SINCE = 1985;
// toYear is the start year of a player's last season ("1984-85" → 1984), so
// +1 matches the year convention used by the custom filters.
const randomPool = () => [...players.values()].filter((p) => (p.toYear ?? 0) + 1 >= RANDOM_SINCE).map((p) => p.id);
// The drawn players are stored on the session so resume and undo see the same 10.
const randomSet = (ids = []) => ({
  id: "random",
  random: true,
  name: `${RANDOM_N} Random Players`,
  filter: (p) => ids.includes(p.id),
});
const setById = (id, opts = {}) => {
  if (id === "custom") return customSet(opts.filter);
  if (id === "random") return Array.isArray(opts.ids) ? randomSet(opts.ids) : undefined;
  if (id === "franchise") return opts.franchise ? franchiseSet(opts.franchise) : undefined;
  return SETS.find((s) => s.id === id);
};
const sessionSet = (s) => setById(s.setId, s);
const idsForSet = (set) => [...players.values()].filter(set.filter).map((p) => p.id);

function rankingTitle(s) {
  const set = sessionSet(s);
  const top = s.mode === "top" ? `Top ${TOP_K}` : "";
  if (set.custom) return `My ${top || "ranking"}: ${set.name}`;
  if (set.random) return `My ranking: ${RANDOM_N} random players`;
  return `My ${top ? `${top} ` : ""}${set.name}`;
}

function loadCustomFilter() {
  try {
    const f = JSON.parse(localStorage.getItem(CUSTOM_KEY));
    if (f && Array.isArray(f.rules)) return withDefaults(f);
  } catch {
    /* ignore */
  }
  return defaultFilter();
}

// ---------- Saved rankings ----------
// Every ranking (in progress or finished) lives in one list. Finished entries
// keep their final order and title so they still display if a data refresh
// later removes their set (e.g. last season's All-Stars).

const RANKINGS_KEY = "nba-ranker:rankings";
const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function markFinished(s, ranking) {
  s.ranking = ranking;
  s.title = rankingTitle(s);
  s.finishedAt ??= Date.now();
}

function writeRankings(list) {
  try {
    localStorage.setItem(RANKINGS_KEY, JSON.stringify(list));
  } catch {
    /* storage full or disabled */
  }
}

function loadRankings() {
  let list = [];
  try {
    const v = JSON.parse(localStorage.getItem(RANKINGS_KEY));
    if (Array.isArray(v)) list = v.filter((r) => r && r.id && Array.isArray(r.answers));
  } catch {
    /* ignore corrupt state */
  }
  // One-time move from the old single-session format.
  try {
    const legacy = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (legacy && Array.isArray(legacy.answers) && sessionSet(legacy)) {
      const now = Date.now();
      const entry = { ...legacy, id: newId(), createdAt: now, updatedAt: now };
      const result = runSort(sessionIds(entry), entry.mode, TOP_K, entry.answers);
      if (result.done) markFinished(entry, result.ranking);
      list.push(entry);
      writeRankings(list);
    }
  } catch {
    /* ignore */
  }
  localStorage.removeItem(STORAGE_KEY);
  return list;
}

function save() {
  if (!session) return;
  session.updatedAt = Date.now();
  const list = loadRankings();
  const i = list.findIndex((r) => r.id === session.id);
  if (i >= 0) list[i] = session;
  else list.push(session);
  writeRankings(list);
}

function deleteRanking(id) {
  writeRankings(loadRankings().filter((r) => r.id !== id));
}

const byRecent = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
const byFinished = (a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
const pinnedFirst = (order) => (a, b) => Boolean(b.pinned) - Boolean(a.pinned) || order(a, b);
const inProgressRankings = () => loadRankings().filter((r) => !r.ranking && sessionSet(r)).sort(byRecent);
const finishedRankings = () =>
  loadRankings()
    .filter((r) => Array.isArray(r.ranking))
    .sort(pinnedFirst(byFinished));

// Pinning doesn't count as activity, so it leaves updatedAt alone.
function togglePinned(id) {
  const list = loadRankings();
  const r = list.find((x) => x.id === id);
  if (!r) return;
  if (r.pinned) delete r.pinned;
  else r.pinned = true;
  writeRankings(list);
}

// Leave the My Rankings page without re-triggering the router.
function clearRoute() {
  if (location.hash) history.pushState(null, "", location.pathname + location.search);
}

function openRanking(r) {
  clearRoute();
  session = r;
  if (r.ranking) renderResults(r.ranking.filter((id) => players.has(id)));
  else renderCompare();
}

function sessionIds(s) {
  return shuffle(idsForSet(sessionSet(s)), s.seed);
}

function setKeys(handler) {
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = handler;
  if (handler) document.addEventListener("keydown", handler);
}

// ---------- Setup ----------

function renderSetup() {
  setKeys(null);
  const pending = inProgressRankings();
  const latest = pending[0];
  let filter = loadCustomFilter();
  app.innerHTML = `
    <section class="setup">
      <h1>Rank the legends.</h1>
      <p class="lede">Pick a group, then choose between two players at a time until your ranking is settled.</p>
      ${
        latest
          ? `<div class="resume">
              <span>${
                pending.length === 1
                  ? `You have a ranking in progress: <strong>${escapeHtml(sessionSet(latest).name)}</strong>
                     (${latest.mode === "top" ? `Top ${TOP_K}` : "full"}, ${latest.answers.length} picks made)`
                  : `You have <strong>${pending.length} rankings</strong> in progress.`
              }</span>
              <span class="resume-actions">
                <button type="button" class="btn" data-action="resume">Resume${pending.length > 1 ? " latest" : ""}</button>
                <a class="btn ghost" href="#my-rankings">My Rankings</a>
              </span>
            </div>`
          : ""
      }
      <form id="setup-form">
        <fieldset>
          <legend>1. Choose players</legend>
          <div class="set-grid">
            ${SETS.map((s, i) => {
              const n = idsForSet(s).length;
              return `<label class="set-card">
                <input type="radio" name="set" value="${s.id}" ${i === 0 ? "checked" : ""} />
                <span class="set-name">${escapeHtml(s.name)}</span>
                <span class="set-desc">${escapeHtml(s.description)}</span>
                <span class="set-count">${n} players</span>
              </label>`;
            }).join("")}
            <label class="set-card">
              <input type="radio" name="set" value="random" />
              <span class="set-name">Rank ${RANDOM_N} Random Players</span>
              <span class="set-desc">A fresh draw of ${RANDOM_N} from ${randomPool().length} players who played in ${RANDOM_SINCE} or later</span>
              <span class="set-count">${RANDOM_N} players</span>
            </label>
            <label class="set-card">
              <input type="radio" name="set" value="franchise" />
              <span class="set-name">Franchise All-Stars</span>
              <span class="set-desc">Every All-Star from one team, while they played there</span>
              <span class="set-count" data-franchise-count></span>
            </label>
            <label class="set-card custom-card">
              <input type="radio" name="set" value="custom" />
              <span class="set-name">Custom</span>
              <span class="set-desc">Build your own group from awards, eras and more</span>
              <span class="set-count" data-custom-count></span>
            </label>
          </div>
          <div class="custom-builder franchise-picker" hidden></div>
          <div class="custom-builder" hidden></div>
        </fieldset>
        <fieldset>
          <legend>2. Choose a mode</legend>
          <div class="mode-grid">
            <label class="mode-card">
              <input type="radio" name="mode" value="top" checked />
              <span class="set-name">Top ${TOP_K}</span>
              <span class="set-desc">Find and order your top ${TOP_K}</span>
              <span class="set-count" data-picks="top"></span>
            </label>
            <label class="mode-card">
              <input type="radio" name="mode" value="full" />
              <span class="set-name">Full ranking</span>
              <span class="set-desc">Rank every player in the group</span>
              <span class="set-count" data-picks="full"></span>
            </label>
          </div>
        </fieldset>
        <button type="submit" class="btn primary big">Start ranking</button>
      </form>
    </section>`;

  const form = app.querySelector("#setup-form");
  const builder = form.querySelector(".custom-builder:not(.franchise-picker)");
  const picker = form.querySelector(".franchise-picker");
  const startBtn = form.querySelector("[type=submit]");
  let franchise = loadFranchiseChoice();

  const currentSet = () => {
    if (form.set.value === "custom") return customSet(filter);
    if (form.set.value === "random") return randomSet([...players.keys()].slice(0, RANDOM_N));
    if (form.set.value === "franchise") return franchiseSet(franchise);
    return setById(form.set.value);
  };

  const update = () => {
    const isCustom = form.set.value === "custom";
    const isFranchise = form.set.value === "franchise";
    builder.hidden = !isCustom;
    picker.hidden = !isFranchise;
    const customIds = idsForSet(customSet(filter));
    form.querySelector("[data-custom-count]").textContent = `${customIds.length} players`;
    if (isCustom) renderCustomPreview(builder, customIds);
    const franchiseIds = idsForSet(franchiseSet(franchise));
    form.querySelector("[data-franchise-count]").textContent = `${franchiseIds.length} players`;
    if (isFranchise) renderCustomPreview(picker, franchiseIds, "Try an earlier year.");
    const n = idsForSet(currentSet()).length;
    for (const el of form.querySelectorAll("[data-picks]")) {
      el.textContent = n < 2 ? "Need at least 2 players" : `Up to ${maxPicks(n, el.dataset.picks, TOP_K)} picks`;
    }
    startBtn.disabled = n < 2;
  };

  const rebuild = () => {
    renderCustomBuilder(builder, filter);
    update();
  };

  const onFilterChange = () => {
    filter = readCustomBuilder(builder);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(filter));
    update();
  };

  // Re-render on team change (banner, former names); typing a year only refreshes counts
  // so the input keeps focus.
  const onFranchiseChange = (e) => {
    const teamChanged = e.target.dataset.f === "team";
    franchise = readFranchisePicker(picker);
    localStorage.setItem(FRANCHISE_KEY, JSON.stringify(franchise));
    if (teamChanged && e.type === "change") renderFranchisePicker(picker, franchise);
    else {
      const sub = picker.querySelector(".team-banner-sub");
      if (sub) sub.textContent = `All-Stars${franchise.since ? ` since ${franchise.since}` : ""}`;
    }
    update();
  };
  renderFranchisePicker(picker, franchise);

  form.addEventListener("change", (e) => {
    if (builder.contains(e.target)) onFilterChange();
    else if (picker.contains(e.target)) onFranchiseChange(e);
    else update();
  });
  builder.addEventListener("input", onFilterChange);
  picker.addEventListener("input", onFranchiseChange);
  builder.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-builder]");
    if (!btn) return;
    const action = btn.dataset.builder;
    if (action === "add") filter.rules.push(defaultRule());
    else if (action === "remove") filter.rules.splice(Number(btn.dataset.index), 1);
    else if (action === "example") filter = withDefaults(EXAMPLES[Number(btn.dataset.index)].filter);
    else if (action === "reset") filter = defaultFilter();
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(filter));
    rebuild();
  });
  rebuild();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const isCustom = form.set.value === "custom";
    const isRandom = form.set.value === "random";
    session = {
      id: newId(),
      createdAt: Date.now(),
      setId: form.set.value,
      ...(isCustom ? { filter: structuredClone(filter) } : {}),
      ...(form.set.value === "franchise" ? { franchise: { ...franchise } } : {}),
      ...(isRandom ? { ids: shuffle(randomPool(), Math.floor(Math.random() * 2 ** 31)).slice(0, RANDOM_N) } : {}),
      mode: form.mode.value,
      seed: Math.floor(Math.random() * 2 ** 31),
      answers: [],
    };
    // Not saved until the first pick, so abandoned starts don't clutter My Rankings.
    renderCompare();
  });

  app.querySelector("[data-action=resume]")?.addEventListener("click", () => openRanking(latest));
}

// ---------- Franchise All-Stars ----------

const FRANCHISE_KEY = "nba-ranker:franchise";
const DEFAULT_FRANCHISE = 1610612747; // Lakers

// One entry per franchise (team id), named after its most recent name, with
// any earlier names (e.g. Seattle SuperSonics for the Thunder).
let franchiseList = null;
function franchises() {
  if (franchiseList) return franchiseList;
  const byId = new Map();
  for (const p of players.values()) {
    for (const s of p.teams ?? []) {
      const f = byId.get(s.teamId) ?? { id: s.teamId, name: s.team, to: 0, names: new Set() };
      if (s.to > f.to) Object.assign(f, { name: s.team, to: s.to });
      f.names.add(s.team);
      byId.set(s.teamId, f);
    }
  }
  franchiseList = [...byId.values()]
    .map((f) => ({ id: f.id, name: f.name, former: [...f.names].filter((n) => n !== f.name) }))
    .filter((f) => [...players.values()].some((p) => allStarWith(p, f.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return franchiseList;
}

// An All-Star season counts when the player was on the franchise that season.
// "2025-26" is the 2026 All-Star Game; stint years use the same convention.
function allStarWith(p, teamId, since) {
  return (p.accolades.seasons.allStar ?? []).some((season) => {
    const year = Number(season.slice(0, 4)) + 1;
    if (since && year < since) return false;
    return (p.teams ?? []).some((t) => t.teamId === teamId && t.from <= year && year <= t.to);
  });
}

function franchiseSet({ team, since }) {
  const f = franchises().find((x) => x.id === team);
  if (!f) return undefined;
  return {
    id: "franchise",
    name: `${f.name} All-Stars${since ? ` since ${since}` : ""}`,
    filter: (p) => allStarWith(p, team, since),
  };
}

function loadFranchiseChoice() {
  try {
    const c = JSON.parse(localStorage.getItem(FRANCHISE_KEY));
    if (c && franchises().some((f) => f.id === c.team)) return { team: c.team, since: c.since || null };
  } catch {
    /* ignore */
  }
  return { team: DEFAULT_FRANCHISE, since: null };
}

function renderFranchisePicker(el, choice) {
  const current = franchises().find((f) => f.id === choice.team);
  const nick = teamNickname(current?.name);
  const [a, b] = TEAM_COLORS[nick] ?? ["#3a4150", "#8b93a3"];
  el.innerHTML = `
    <div class="team-banner" style="--team-a:${a};--team-b:${b}">
      <span class="team-logo"><img src="https://cdn.nba.com/logos/nba/${choice.team}/primary/L/logo.svg" alt="" onerror="this.remove()" /></span>
      <span class="team-banner-text">
        <span class="team-banner-name">${escapeHtml(current?.name ?? "")}</span>
        <span class="team-banner-sub">All-Stars${choice.since ? ` since ${choice.since}` : ""}</span>
      </span>
    </div>
    <div class="builder-section">
      <span class="builder-label">Franchise</span>
      <span class="rule-line">
        <select data-f="team" aria-label="Franchise">
          ${franchises()
            .map((f) => `<option value="${f.id}" ${f.id === choice.team ? "selected" : ""}>${escapeHtml(f.name)}</option>`)
            .join("")}
        </select>
      </span>
      ${current?.former.length ? `<p class="hint">Includes the ${escapeHtml(current.former.join(", "))} years.</p>` : ""}
    </div>
    <div class="builder-section">
      <span class="builder-label">All-Star selections</span>
      <span class="rule-line">
        <span class="rule-word">since</span>
        ${yearInput("since", choice.since, "any year", 'aria-label="Since season"')}
      </span>
      <p class="hint">Only All-Star selections made while playing for this team count. 2015 means the 2014–15 season.</p>
    </div>
    <p class="custom-preview" aria-live="polite"></p>`;
}

function readFranchisePicker(el) {
  const since = Number(el.querySelector("[data-f=since]").value);
  return {
    team: Number(el.querySelector("[data-f=team]").value),
    since: since >= FIRST_YEAR && since <= thisYear + 1 ? since : null,
  };
}

// ---------- Custom builder ----------

const yearInput = (name, value, placeholder, extra = "") =>
  `<input type="number" inputmode="numeric" class="year" data-f="${name}" min="${FIRST_YEAR}" max="${thisYear}"
    placeholder="${placeholder}" value="${value ?? ""}" ${extra} />`;

function awardSelect(selected) {
  const groups = [...new Set(AWARDS.map((a) => a.group))];
  return `<select data-f="award" aria-label="Award">
    ${groups
      .map(
        (g) => `<optgroup label="${g}">
          ${AWARDS.filter((a) => a.group === g)
            .map((a) => `<option value="${a.key}" ${a.key === selected ? "selected" : ""}>${escapeHtml(a.many)}</option>`)
            .join("")}
        </optgroup>`
      )
      .join("")}
  </select>`;
}

function renderCustomBuilder(el, f) {
  el.innerHTML = `
    <div class="examples">
      <span class="builder-label">Try one:</span>
      ${EXAMPLES.map(
        (ex, i) => `<button type="button" class="chip-btn" data-builder="example" data-index="${i}">${escapeHtml(ex.label)}</button>`
      ).join("")}
    </div>

    <div class="builder-section">
      <div class="builder-head">
        <span class="builder-label">Players with…</span>
      </div>
      <div class="rules">
        ${f.rules
          .map(
            (r, i) => `<div class="rule" data-rule="${i}">
              <span class="rule-line">
                <span class="rule-word">At least</span>
                <input type="number" inputmode="numeric" class="count" data-f="min" min="1" max="30" value="${r.min ?? 1}" aria-label="Minimum count" />
                ${awardSelect(r.award)}
                ${
                  f.rules.length > 1
                    ? `<button type="button" class="icon-btn" data-builder="remove" data-index="${i}" aria-label="Remove rule">✕</button>`
                    : ""
                }
              </span>
            </div>`
          )
          .join("")}
      </div>
      <button type="button" class="btn ghost small" data-builder="add">+ Add rule</button>
    </div>

    <div class="builder-section">
      <span class="builder-label">Seasons</span>
      <span class="rule-line">
        <span class="rule-word">from</span>
        ${yearInput("from", f.from, "any year", 'aria-label="From season"')}
        <span class="rule-word">to</span>
        ${yearInput("to", f.to, "now", 'aria-label="To season"')}
      </span>
      <p class="hint">Only awards won in these seasons count. 2015 means the 2014–15 season.</p>
    </div>

    <details class="builder-section more" ${hasExtras(f) ? "open" : ""}>
      <summary class="builder-label">More filters</summary>
      <div class="extra-grid">
        <div class="extra">
          <span class="extra-label">Status</span>
          <span class="segmented">
            ${["any", "active", "retired"]
              .map(
                (s) => `<label><input type="radio" name="status" data-f="status" value="${s}" ${f.status === s ? "checked" : ""} />
                  <span>${s[0].toUpperCase() + s.slice(1)}</span></label>`
              )
              .join("")}
          </span>
        </div>
        <div class="extra">
          <span class="extra-label">Position</span>
          <span class="segmented">
            ${POSITIONS.map(
              (p) => `<label><input type="checkbox" data-f="positions" value="${p}" ${f.positions.includes(p) ? "checked" : ""} />
                <span>${p}</span></label>`
            ).join("")}
          </span>
        </div>
      </div>
    </details>

    <div class="custom-preview" aria-live="polite"></div>
    <button type="button" class="btn ghost small" data-builder="reset">Reset filters</button>`;
}

const hasExtras = (f) => f.status !== "any" || f.positions.length;

function readCustomBuilder(el) {
  const num = (input) => {
    const v = parseFloat(input?.value);
    return Number.isFinite(v) ? v : null;
  };
  const year = (input) => {
    const v = num(input);
    return v && v >= FIRST_YEAR && v <= thisYear ? Math.round(v) : null;
  };
  const q = (sel) => el.querySelector(sel);
  return {
    rules: [...el.querySelectorAll("[data-rule]")].map((row) => ({
      award: row.querySelector("[data-f=award]").value,
      min: Math.max(1, Math.round(num(row.querySelector("[data-f=min]")) || 1)),
    })),
    from: year(q("[data-f=from]")),
    to: year(q("[data-f=to]")),
    status: q("[data-f=status]:checked")?.value ?? "any",
    positions: [...el.querySelectorAll("[data-f=positions]:checked")].map((i) => i.value),
  };
}

function renderCustomPreview(el, ids, emptyHint = "Try loosening a rule.") {
  const preview = el.querySelector(".custom-preview");
  if (!preview) return;
  if (!ids.length) {
    preview.innerHTML = `<strong>No players match.</strong> ${emptyHint}`;
    return;
  }
  const sample = ids
    .map((id) => players.get(id))
    .sort((a, b) => b.accolades.allStar - a.accolades.allStar || b.careerRegularSeason.pts - a.careerRegularSeason.pts);
  const shown = sample.slice(0, 12);
  preview.innerHTML = `<strong>${ids.length} ${ids.length === 1 ? "player matches" : "players match"}</strong>
    ${ids.length < 2 ? " (need at least 2)" : ""}
    <span class="preview-names">${shown.map((p) => escapeHtml(p.name)).join(", ")}${
      sample.length > shown.length ? `, +${sample.length - shown.length} more` : ""
    }</span>`;
}

// ---------- Compare ----------

function accoladeChips(a) {
  const chips = [
    [a.championships, "🏆", "Champion"],
    [a.mvp, "MVP", ""],
    [a.finalsMvp, "Finals MVP", ""],
    [a.dpoy, "DPOY", ""],
    [a.allStar, "All-Star", ""],
    [a.allNba, "All-NBA", ""],
    [a.allDefensive, "All-Defense", ""],
    [a.roy, "ROY", ""],
  ];
  return chips
    .filter(([n]) => n > 0)
    .map(([n, label]) => `<span class="chip">${n > 1 ? `${n}× ` : ""}${label}</span>`)
    .join("");
}

// [primary, secondary] by team nickname, including relocated/defunct franchises.
const TEAM_COLORS = {
  Hawks: ["#E03A3E", "#C1D32F"], Celtics: ["#007A33", "#BA9653"], Nets: ["#2A2A2A", "#FFFFFF"],
  Bobcats: ["#F26532", "#2F598C"], Hornets: ["#1D1160", "#00788C"], Bulls: ["#CE1141", "#1A1A1A"],
  Cavaliers: ["#860038", "#FDBB30"], Mavericks: ["#00538C", "#B8C4CA"], Nuggets: ["#0E2240", "#FEC524"],
  Pistons: ["#C8102E", "#1D42BA"], Warriors: ["#1D428A", "#FFC72C"], Rockets: ["#CE1141", "#C4CED4"],
  Pacers: ["#002D62", "#FDBB30"], Clippers: ["#C8102E", "#1D428A"], Lakers: ["#552583", "#FDB927"],
  Grizzlies: ["#5D76A9", "#12173F"], Heat: ["#98002E", "#F9A01B"], Bucks: ["#00471B", "#EEE1C6"],
  Timberwolves: ["#0C2340", "#78BE20"], Pelicans: ["#0C2340", "#C8102E"], Knicks: ["#006BB6", "#F58426"],
  Thunder: ["#007AC1", "#EF3B24"], Magic: ["#0077C0", "#C4CED4"], "76ers": ["#006BB6", "#ED174C"],
  Suns: ["#1D1160", "#E56020"], "Trail Blazers": ["#E03A3E", "#1A1A1A"], Kings: ["#5A2D81", "#63727A"],
  Spurs: ["#2A2A2A", "#C4CED4"], SuperSonics: ["#00653A", "#FFC200"], Raptors: ["#CE1141", "#1A1A1A"],
  Jazz: ["#002B5C", "#F9A01B"], Wizards: ["#002B5C", "#E31837"], Bullets: ["#C8102E", "#002B5C"],
  Royals: ["#003DA5", "#E31837"], Nationals: ["#C8102E", "#1D428A"], Olympians: ["#E31837", "#003DA5"],
  Braves: ["#0B3D91", "#F58426"], Stags: ["#CE1141", "#002B5C"], Capitols: ["#002B5C", "#C8102E"],
};
const teamNickname = (team) => Object.keys(TEAM_COLORS).find((n) => team?.endsWith(n));

function headshot(p, cls = "") {
  const initials = p.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
  if (!p.headshot) {
    const nick = teamNickname(p.primaryTeam ?? p.lastTeam);
    const [a, b] = TEAM_COLORS[nick] ?? ["#3a4150", "#8b93a3"];
    return `<div class="headshot no-photo ${cls}" style="--team-a:${a};--team-b:${b}" role="img" aria-label="${escapeHtml(p.name)}">
      <span class="initials">${escapeHtml(initials)}</span>
      ${nick ? `<span class="team-tag">${escapeHtml(nick)}</span>` : ""}
    </div>`;
  }
  return `<div class="headshot ${cls}" data-initials="${escapeHtml(initials)}">
    <img src="${p.headshot}" alt="" loading="lazy" onerror="this.remove()" />
  </div>`;
}

const fmt = (v, digits = 1) => (v == null ? "–" : Number(v).toFixed(digits));

function playerCard(p, side) {
  const s = p.careerRegularSeason || {};
  return `<button class="player-card" data-pick="${p.id}" aria-label="Pick ${escapeHtml(p.name)}">
    ${headshot(p)}
    <span class="card-body">
      <span class="player-name">${escapeHtml(p.name)}</span>
      <span class="player-meta">${escapeHtml(p.position || "")} · ${p.fromYear}–${p.active ? "now" : p.toYear}</span>
      <span class="stat-row">
        <span><strong>${fmt(s.pts)}</strong>PTS</span>
        <span><strong>${fmt(s.reb)}</strong>REB</span>
        <span><strong>${fmt(s.ast)}</strong>AST</span>
      </span>
      <span class="chips">${accoladeChips(p.accolades)}</span>
    </span>
    <span class="key-hint">${side === "left" ? "← key" : "→ key"}</span>
  </button>`;
}

// Stable per-pair coin flip so left/right placement is random but survives undo.
function orderPair([a, b]) {
  const key = pairKey(a, b) + session.seed;
  let h = 0;
  for (const c of key) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return h & 1 ? [a, b] : [b, a];
}

function renderCompare() {
  const ids = sessionIds(session);
  const result = runSort(ids, session.mode, TOP_K, session.answers);
  if (result.done) {
    if (!session.ranking) {
      markFinished(session, result.ranking);
      save();
    }
    renderResults(session.ranking);
    return;
  }

  const set = sessionSet(session);
  const total = maxPicks(ids.length, session.mode, TOP_K);
  const done = session.answers.length;
  const pct = Math.min(99, Math.round((done / total) * 100));
  const [left, right] = orderPair(result.pair).map((id) => players.get(id));

  app.innerHTML = `
    <section class="compare">
      <div class="compare-header">
        <span>${escapeHtml(set.name)} · ${session.mode === "top" ? `Top ${TOP_K}` : "Full ranking"}</span>
        <span>Pick ${done + 1} · up to ${total}</span>
      </div>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div style="width:${pct}%"></div>
      </div>
      <h2>Who do you rank higher?</h2>
      <div class="versus">
        ${playerCard(left, "left")}
        <span class="vs">VS</span>
        ${playerCard(right, "right")}
      </div>
      <div class="compare-actions">
        <button class="btn ghost" data-action="undo" ${done ? "" : "disabled"}>↶ Undo</button>
        <button class="btn ghost" data-action="exit">${done ? "Save &amp; exit" : "Back"}</button>
        <button class="btn ghost" data-action="discard" ${done ? "" : "hidden"}>Discard</button>
      </div>
    </section>`;

  const pick = (winner) => {
    const [a, b] = result.pair;
    session.answers.push({ a, b, winner });
    save();
    renderCompare();
  };
  const undo = () => {
    if (!session.answers.length) return;
    session.answers.pop();
    save();
    renderCompare();
  };

  for (const btn of app.querySelectorAll("[data-pick]")) {
    btn.addEventListener("click", () => pick(Number(btn.dataset.pick)));
  }
  // The new card renders under the cursor that just picked; hold off on the
  // hover highlight until the pointer actually moves.
  const versus = app.querySelector(".versus");
  versus.classList.add("await-pointer");
  versus.addEventListener("pointermove", () => versus.classList.remove("await-pointer"), { once: true });
  app.querySelector("[data-action=undo]").addEventListener("click", undo);
  app.querySelector("[data-action=exit]").addEventListener("click", () => {
    session = null;
    if (done) location.hash = "#my-rankings";
    else renderSetup();
  });
  app.querySelector("[data-action=discard]").addEventListener("click", () => {
    if (!confirm("Discard this ranking? This can't be undone.")) return;
    deleteRanking(session.id);
    session = null;
    renderSetup();
  });
  setKeys((e) => {
    if (e.key === "ArrowLeft") pick(left.id);
    else if (e.key === "ArrowRight") pick(right.id);
    else if (e.key === "Backspace" || (e.key === "z" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      undo();
    }
  });
}

// ---------- Results ----------

function renderResults(ranking) {
  setKeys(null);
  const ranked = ranking.map((id) => players.get(id));
  const podium = ranked.slice(0, 3);
  const featured = ranked.slice(3, 10);
  const rest = ranked.slice(10);
  const title = session.title ?? rankingTitle(session);
  const canUndo = Boolean(sessionSet(session)) && session.answers.length > 0;

  const statLine = (p) => {
    const s = p.careerRegularSeason || {};
    return `${fmt(s.pts)} PTS · ${fmt(s.reb)} REB · ${fmt(s.ast)} AST`;
  };

  app.innerHTML = `
    <section class="results">
      <h1>${escapeHtml(title)}</h1>
      <ol class="podium">
        ${podium
          .map(
            (p, i) => `<li class="podium-card rank-${i + 1}">
              <span class="rank">${i + 1}</span>
              ${headshot(p, "large")}
              <span class="player-name">${escapeHtml(p.name)}</span>
              <span class="player-meta">${statLine(p)}</span>
              <span class="chips">${accoladeChips(p.accolades)}</span>
            </li>`
          )
          .join("")}
      </ol>
      ${
        featured.length
          ? `<ol class="featured" start="4">
              ${featured
                .map(
                  (p, i) => `<li>
                    <span class="rank">${i + 4}</span>
                    ${headshot(p, "small")}
                    <span class="featured-text">
                      <span class="player-name">${escapeHtml(p.name)}</span>
                      <span class="player-meta">${statLine(p)}</span>
                    </span>
                  </li>`
                )
                .join("")}
            </ol>`
          : ""
      }
      ${
        rest.length
          ? `<ol class="rest" start="11">
              ${rest.map((p, i) => `<li><span class="rank">${i + 11}</span>${escapeHtml(p.name)}</li>`).join("")}
            </ol>`
          : ""
      }
      <div class="results-actions">
        <button class="btn primary" data-action="image">Save image</button>
        <button class="btn" data-action="copy">Copy as text</button>
        <button class="btn" data-action="undo" ${canUndo ? "" : "hidden"}>↶ Undo last pick</button>
        <a class="btn ghost" href="#my-rankings/finished">My Rankings</a>
        <button class="btn ghost" data-action="new">Rank again</button>
      </div>
    </section>`;

  app.querySelector("[data-action=image]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      const set = sessionSet(session);
      const heading = session.mode === "top" ? `My Top ${TOP_K}` : "My ranking";
      const blob = await renderRankingImage({
        title: set?.custom ? heading : title,
        subtitle: set?.custom ? set.name : "",
        ranked,
        footer: "zateutsch.github.io/nba-ranker",
      });
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      const file = new File([blob], `${slug || "nba-ranking"}.png`, { type: "image/png" });
      // Phones: the share sheet lets people save to Photos or post directly.
      const touch = matchMedia("(pointer: coarse)").matches;
      if (touch && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title });
        } catch (err) {
          if (err.name !== "AbortError") throw err;
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      btn.textContent = label;
    } catch {
      btn.textContent = "Couldn't save image";
    } finally {
      btn.disabled = false;
    }
  });
  app.querySelector("[data-action=copy]").addEventListener("click", async (e) => {
    const text = `${title}\n${ranked.map((p, i) => `${i + 1}. ${p.name}`).join("\n")}`;
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = "Copied!";
    } catch {
      e.target.textContent = "Copy failed";
    }
  });
  app.querySelector("[data-action=undo]").addEventListener("click", () => {
    session.answers.pop();
    delete session.ranking;
    delete session.title;
    delete session.finishedAt;
    save();
    renderCompare();
  });
  app.querySelector("[data-action=new]").addEventListener("click", () => {
    session = null;
    clearRoute();
    renderSetup();
  });
}

// ---------- My Rankings ----------

const shortDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
};

const PIN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z"/><path d="M12 15v6"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/></svg>`;

// The whole card opens the ranking via a full-card button; the icon buttons sit above it.
function savedHead(r, title, meta, { pinnable = false, openLabel }) {
  return `<button type="button" class="saved-open" data-open="${r.id}" aria-label="${escapeHtml(`${openLabel} ${title}`)}"></button>
    <div class="saved-head">
      <div class="saved-text">
        <span class="saved-title">${escapeHtml(title)}</span>
        <span class="saved-meta">${escapeHtml(meta)}</span>
      </div>
      <div class="saved-icons">
        ${
          pinnable
            ? `<button type="button" class="icon-btn pin" data-pin="${r.id}" aria-pressed="${Boolean(r.pinned)}"
                aria-label="${r.pinned ? "Unpin" : "Pin to top"}" title="${r.pinned ? "Unpin" : "Pin to top"}">${PIN_ICON}</button>`
            : ""
        }
        <button type="button" class="icon-btn delete" data-delete="${r.id}" aria-label="Delete" title="Delete">${TRASH_ICON}</button>
      </div>
    </div>`;
}

function progressCard(r) {
  const set = sessionSet(r);
  const n = idsForSet(set).length;
  const total = maxPicks(n, r.mode, TOP_K);
  const pct = Math.min(99, Math.round((r.answers.length / total) * 100));
  return `<li class="saved-card">
    ${savedHead(r, set.name, `${r.mode === "top" ? `Top ${TOP_K}` : "Full ranking"} · ${r.answers.length} of up to ${total} picks · ${shortDate(r.updatedAt)}`, { openLabel: "Resume" })}
    <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
  </li>`;
}

function finishedCard(r) {
  const top = r.ranking.map((id) => players.get(id)).filter(Boolean).slice(0, 3);
  return `<li class="saved-card${r.pinned ? " pinned" : ""}">
    ${savedHead(r, r.title, `${r.ranking.length} players · finished ${shortDate(r.finishedAt)}`, { pinnable: true, openLabel: "View" })}
    <ol class="saved-top">
      ${top.map((p) => `<li>${escapeHtml(p.name)}</li>`).join("")}
    </ol>
  </li>`;
}

// ---------- Backup / restore ----------

const BACKUP_APP = "nba-ranker";
const BACKUP_MAX_BYTES = 5_000_000;

function downloadBackup() {
  const today = new Date().toISOString().slice(0, 10);
  const data = { app: BACKUP_APP, version: 1, exportedAt: new Date().toISOString(), rankings: loadRankings() };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: `nba-rankings-${today}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const validRanking = (r) =>
  r && typeof r === "object" && typeof r.id === "string" && typeof r.setId === "string" && Array.isArray(r.answers) &&
  r.answers.every((x) => x && Number.isFinite(x.a) && Number.isFinite(x.b) && Number.isFinite(x.winner)) &&
  (r.ranking === undefined || (Array.isArray(r.ranking) && r.ranking.every(Number.isFinite)));

// Merges by id; when a ranking is in both, the more recently updated copy wins.
async function restoreBackup(file) {
  if (file.size > BACKUP_MAX_BYTES) throw new Error("That file is too large to be a backup.");
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't an NBA Ranker backup.");
  }
  if (data?.app !== BACKUP_APP || !Array.isArray(data.rankings)) throw new Error("That file isn't an NBA Ranker backup.");
  const incoming = data.rankings.filter(validRanking);
  const list = loadRankings();
  const index = new Map(list.map((r, i) => [r.id, i]));
  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    const i = index.get(r.id);
    if (i === undefined) {
      index.set(r.id, list.push(r) - 1);
      added++;
    } else if ((r.updatedAt ?? 0) > (list[i].updatedAt ?? 0)) {
      list[i] = r;
      updated++;
    }
  }
  writeRankings(list);
  const plural = (n) => `${n} ranking${n === 1 ? "" : "s"}`;
  if (!added && !updated) return "Everything in that backup is already here.";
  return `Restored ${plural(added)}${updated ? ` and updated ${plural(updated)}` : ""}.`;
}

function renderMyRankings(tab, status = "") {
  setKeys(null);
  const progress = inProgressRankings();
  const finished = finishedRankings();
  tab ??= progress.length || !finished.length ? "progress" : "finished";
  const list = tab === "progress" ? progress : finished;

  app.innerHTML = `
    <section class="my-rankings">
      <h1>My Rankings</h1>
      <p class="lede">Saved on this device. Clearing your browser data removes them, so back them up to a file now and then.</p>
      <div class="backup-row">
        <a class="btn primary small" href="./">+ New ranking</a>
        <button type="button" class="btn ghost small" data-action="backup" ${loadRankings().length ? "" : "disabled"}>Back up</button>
        <label class="btn ghost small file-btn">Restore<input type="file" accept=".json,application/json" data-action="restore" /></label>
        <span class="backup-status" role="status">${escapeHtml(status)}</span>
      </div>
      <div class="tabs" role="tablist">
        <a role="tab" class="tab" href="#my-rankings/in-progress" aria-selected="${tab === "progress"}">In Progress <span class="tab-count">${progress.length}</span></a>
        <a role="tab" class="tab" href="#my-rankings/finished" aria-selected="${tab === "finished"}">Finished <span class="tab-count">${finished.length}</span></a>
      </div>
      ${
        list.length
          ? `<ul class="saved-list">${list.map(tab === "progress" ? progressCard : finishedCard).join("")}</ul>`
          : `<div class="saved-empty">
              <p>${tab === "progress" ? "No rankings in progress." : "No finished rankings yet."}</p>
            </div>`
      }
    </section>`;

  app.querySelector("[data-action=backup]").addEventListener("click", downloadBackup);
  app.querySelector("[data-action=restore]").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    let message;
    try {
      message = await restoreBackup(file);
    } catch (err) {
      message = err.message;
    }
    renderMyRankings(tab, message);
  });

  const byId = new Map(list.map((r) => [r.id, r]));
  app.querySelector(".saved-list")?.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    const pin = e.target.closest("[data-pin]");
    const del = e.target.closest("[data-delete]");
    if (open) openRanking(byId.get(open.dataset.open));
    else if (pin) {
      togglePinned(pin.dataset.pin);
      renderMyRankings(tab);
      app.querySelector(`[data-pin="${pin.dataset.pin}"]`)?.focus();
    } else if (del) {
      const r = byId.get(del.dataset.delete);
      const name = r.title ?? sessionSet(r)?.name ?? "this ranking";
      if (!confirm(`Delete “${name}”? This can't be undone.`)) return;
      deleteRanking(r.id);
      renderMyRankings(tab);
    }
  });
}

// ---------- Routing ----------

function route() {
  session = null;
  const hash = location.hash;
  if (hash === "#my-rankings") renderMyRankings();
  else if (hash === "#my-rankings/in-progress") renderMyRankings("progress");
  else if (hash === "#my-rankings/finished") renderMyRankings("finished");
  else renderSetup();
  window.scrollTo(0, 0);
}

// ---------- Boot ----------

async function init() {
  try {
    const res = await fetch("data/players.json");
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    players = new Map(data.players.map((p) => [p.id, p]));
    addLatestAllStarSet();
  } catch (err) {
    app.innerHTML = `<p class="error">Couldn't load player data (${escapeHtml(err.message)}).</p>`;
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}

init();
