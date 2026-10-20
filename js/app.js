import { runSort, maxPicks, shuffle, pairKey } from "./sorter.js";
import { AWARDS, POSITIONS, EXAMPLES, defaultRule, defaultFilter, withDefaults, matches, describe } from "./custom.js";
import {
  renderLeaguePredictionImage,
  renderPredictionImage,
  renderRankingImage,
} from "./share-image.js?v=named-image-headers-1";

const TOP_K = 10;
const STORAGE_KEY = "nba-ranker:session";
const CUSTOM_KEY = "nba-ranker:custom";
const PREDICTION_KEY = "nba-ranker:season-prediction";
const PREDICTIONS_KEY = "nba-ranker:season-predictions";
const LEAGUE_PREDICTION_KEY = "nba-ranker:league-prediction";
const LEAGUE_PREDICTIONS_KEY = "nba-ranker:league-predictions";
const EASTERN_CONFERENCE = new Set([
  "Atlanta Hawks",
  "Boston Celtics",
  "Brooklyn Nets",
  "Charlotte Hornets",
  "Chicago Bulls",
  "Cleveland Cavaliers",
  "Detroit Pistons",
  "Indiana Pacers",
  "Miami Heat",
  "Milwaukee Bucks",
  "New York Knicks",
  "Orlando Magic",
  "Philadelphia 76ers",
  "Toronto Raptors",
  "Washington Wizards",
]);
const FIRST_YEAR = 1947;
const thisYear = new Date().getFullYear();

// ---------- Theme toggle ----------
(function setupTheme() {
  const root = document.documentElement;
  const btn = document.getElementById("theme-toggle");

  const sync = () => {
    const dark = root.getAttribute("data-theme") === "dark";
    if (btn) {
      btn.setAttribute("aria-pressed", String(dark));
      btn.setAttribute(
        "aria-label",
        dark ? "Switch to light theme" : "Switch to dark theme"
      );
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute(
        "content",
        getComputedStyle(root).getPropertyValue("--bg-top").trim() ||
          (dark ? "#17102f" : "#f6f7f9")
      );
    }
  };

  const apply = (theme, persist) => {
    root.setAttribute("data-theme", theme);
    if (persist) {
      try {
        localStorage.setItem("theme", theme);
      } catch (e) {}
    }
    sync();
  };

  if (btn) {
    btn.addEventListener("click", () => {
      const next =
        root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next, true);
    });
  }

  apply("dark", false);
})();

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
let scheduleData = null;
let session = null; // { setId, filter?, mode, seed, answers: [{ a, b, winner }] }
let keyHandler = null;

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const EDIT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>`;

async function saveImageBlob(blob, fileName, title) {
  const file = new File([blob], fileName, { type: "image/png" });
  const touch = matchMedia("(pointer: coarse)").matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

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

const cleanName = (value) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 80);

function rankingDisplayTitle(ranking) {
  return cleanName(ranking.name) || ranking.title || (sessionSet(ranking) ? rankingTitle(ranking) : "My ranking");
}

function rankingRules(ranking) {
  const set = sessionSet(ranking);
  return `${set?.name ?? "NBA players"} · ${ranking.mode === "top" ? `Top ${TOP_K}` : "Full ranking"}`;
}

function teamPredictionTitle(prediction) {
  return cleanName(prediction.name) || `${prediction.team} Prediction`;
}

function teamPredictionRules(prediction, season) {
  return `${season.label} · ${prediction.team} · Opponent-series picks`;
}

function leaguePredictionTitle(prediction) {
  return cleanName(prediction.name) || "Full-League Prediction";
}

function leaguePredictionRules(prediction, season) {
  return `${season.label} · Entire NBA · Shared game results`;
}

function editableResultTitle(title, name = "") {
  return `
    <div class="result-title-row">
      <h1>${escapeHtml(title)}</h1>
      <button type="button" class="icon-btn edit" data-edit-result-name
        aria-label="Edit name" title="Edit name">${EDIT_ICON}</button>
    </div>
    ${nameDialog("result", name, title)}`;
}

function nameDialog(kind, name = "", placeholder = "") {
  return `<dialog class="picker-dialog name-dialog" data-name-dialog="${kind}">
    <form class="dialog-body" data-name-dialog-form>
      <h2 class="dialog-title">Edit name</h2>
      <label class="name-field">
        <span>Name <small>Optional</small></span>
        <input type="text" maxlength="80" autocomplete="off" value="${escapeHtml(name)}"
          placeholder="${escapeHtml(placeholder)}" />
      </label>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" data-name-dialog-cancel>Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>
  </dialog>`;
}

function openNameDialog(dialog, name, placeholder) {
  const input = dialog.querySelector("input");
  input.value = name ?? "";
  input.placeholder = placeholder;
  dialog.showModal();
  input.focus();
  input.select();
}

function bindNameDialog(dialog, onSave) {
  if (!dialog) return;
  dialog.querySelector("[data-name-dialog-cancel]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.querySelector("[data-name-dialog-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    onSave(cleanName(dialog.querySelector("input").value));
  });
}

function bindResultNameEditor(onSave) {
  const edit = app.querySelector("[data-edit-result-name]");
  const dialog = app.querySelector('[data-name-dialog="result"]');
  if (!edit || !dialog) return;
  edit.addEventListener("click", () =>
    openNameDialog(dialog, dialog.querySelector("input").value, dialog.querySelector("input").placeholder)
  );
  bindNameDialog(dialog, onSave);
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

// Which of the three pickers (preset / team / custom) was last used.
const SELECTION_KEY = "nba-ranker:selection";
function loadSelection() {
  try {
    const c = JSON.parse(localStorage.getItem(SELECTION_KEY));
    if (c && c.kind === "franchise") return { kind: "franchise" };
    if (c && c.kind === "custom") return { kind: "custom" };
    if (c && c.kind === "preset" && (c.setId === "random" || SETS.some((s) => s.id === c.setId)))
      return { kind: "preset", setId: c.setId };
  } catch {
    /* ignore */
  }
  return { kind: "preset", setId: SETS[0]?.id ?? "active-all-stars" };
}
function saveSelection(c) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

// ---------- Feature home ----------

function renderHome() {
  setKeys(null);
  const scheduleReady = Boolean(scheduleData?.seasons?.length);
  app.innerHTML = `
    <section class="feature-home">
      <h1>Choose your NBA challenge.</h1>
      <p class="lede">Rank the players who defined the league, or predict every game in a team's season.</p>
      <div class="feature-grid">
        <a class="feature-card" href="#player-ranking">
          <span class="feature-kicker">Player ranking</span>
          <strong>Rank</strong>
          <span>Choose a group of NBA players, make head-to-head picks, and build your personal player ranking.</span>
          <span class="feature-action">Start ranking &rarr;</span>
        </a>
        ${
          scheduleReady
            ? `<a class="feature-card" href="#season-prediction">
                <span class="feature-kicker">Season prediction</span>
                <strong>Predict</strong>
                <span>Predict one team's schedule or call every game across the entire league.</span>
                <span class="feature-action">Start predicting &rarr;</span>
              </a>`
            : `<div class="feature-card is-disabled" aria-disabled="true">
                <span class="feature-kicker">Season prediction</span>
                <strong>Schedule unavailable</strong>
                <span>The schedule data could not be loaded.</span>
              </div>`
        }
      </div>
    </section>`;
}

// ---------- Saved rankings ----------
// Every ranking (in progress or finished) lives in one list. Finished entries
// keep their final order and title so they still display if a data refresh
// later removes their set (e.g. last season's All-Stars).

const RANKINGS_KEY = "nba-ranker:rankings";
const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function markFinished(s, ranking) {
  s.ranking = ranking;
  s.title = rankingDisplayTitle(s);
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

function renameRanking(id, name) {
  const list = loadRankings();
  const ranking = list.find((item) => item.id === id);
  if (!ranking) return;
  ranking.name = name;
  ranking.title = name || rankingTitle(ranking);
  ranking.updatedAt = Date.now();
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
  let franchise = loadFranchiseChoice();
  let choice = loadSelection();

  const presetCard = (id, name, desc, count, checked) => `
    <label class="set-card">
      <input type="radio" name="preset-set" value="${id}" ${checked ? "checked" : ""} />
      <span class="set-name">${escapeHtml(name)}</span>
      <span class="set-desc">${escapeHtml(desc)}</span>
      <span class="set-count">${count} players</span>
    </label>`;

  const presetCards = () => {
    const cards = SETS.map((s) =>
      presetCard(s.id, s.name, s.description, idsForSet(s).length, choice.kind === "preset" && choice.setId === s.id)
    );
    cards.push(
      presetCard(
        "random",
        `${RANDOM_N} Random Players`,
        `A fresh draw of ${RANDOM_N} from ${randomPool().length} players who played in ${RANDOM_SINCE} or later`,
        RANDOM_N,
        choice.kind === "preset" && choice.setId === "random"
      )
    );
    return cards.join("");
  };

  app.innerHTML = `
    <section class="setup">
      <h1>Rank NBA players, past and present.</h1>
      <p class="lede">Pick a group, then choose between two players at a time until your ranking is settled.</p>
      ${
        latest
          ? `<div class="resume">
              <span>${
                pending.length === 1
                  ? `You have a ranking in progress: <strong>${escapeHtml(rankingDisplayTitle(latest))}</strong>
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
          <div class="chooser">
            <button type="button" class="choice-btn" data-open="preset">
              <span class="choice-top">
                <span class="choice-head">Preset</span>
                <span class="choice-action">Choose &rarr;</span>
              </span>
              <span class="choice-sub" data-sub="preset"></span>
            </button>
            <button type="button" class="choice-btn" data-open="franchise">
              <span class="choice-top">
                <span class="choice-head">Rank From a Team</span>
                <span class="choice-action">Choose &rarr;</span>
              </span>
              <span class="choice-sub" data-sub="franchise"></span>
            </button>
            <button type="button" class="choice-btn" data-open="custom">
              <span class="choice-top">
                <span class="choice-head">Custom</span>
                <span class="choice-action">Choose &rarr;</span>
              </span>
              <span class="choice-sub" data-sub="custom"></span>
            </button>
          </div>
          <p class="selection-summary" data-selection-summary></p>
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
        <fieldset>
          <legend>3. Name your ranking</legend>
          <label class="name-field">
            <span>Optional</span>
            <input type="text" name="rankingName" maxlength="80"
              placeholder="e.g. My all-time favorites" autocomplete="off" />
          </label>
        </fieldset>
        <button type="submit" class="btn primary big">Start ranking</button>
      </form>

      <dialog class="picker-dialog" data-dialog="preset">
        <div class="dialog-body">
          <h2 class="dialog-title">Choose a preset group</h2>
          <div class="set-grid preset-grid">${presetCards()}</div>
          <div class="dialog-actions">
            <button type="button" class="btn ghost" data-dialog-cancel>Cancel</button>
            <button type="button" class="btn primary" data-dialog-confirm>Use group</button>
          </div>
        </div>
      </dialog>

      <dialog class="picker-dialog" data-dialog="franchise">
        <div class="dialog-body">
          <h2 class="dialog-title">Rank from a team</h2>
          <div class="custom-builder franchise-picker"></div>
          <div class="dialog-actions">
            <button type="button" class="btn ghost" data-dialog-cancel>Cancel</button>
            <button type="button" class="btn primary" data-dialog-confirm>Use team</button>
          </div>
        </div>
      </dialog>

      <dialog class="picker-dialog" data-dialog="custom">
        <div class="dialog-body">
          <h2 class="dialog-title">Build a custom group</h2>
          <div class="custom-builder custom-picker"></div>
          <div class="dialog-actions">
            <button type="button" class="btn ghost" data-dialog-cancel>Cancel</button>
            <button type="button" class="btn primary" data-dialog-confirm>Use group</button>
          </div>
        </div>
      </dialog>
    </section>`;

  const form = app.querySelector("#setup-form");
  const section = app.querySelector(".setup");
  const startBtn = form.querySelector("[type=submit]");
  const dlgPreset = section.querySelector('[data-dialog="preset"]');
  const dlgFranchise = section.querySelector('[data-dialog="franchise"]');
  const dlgCustom = section.querySelector('[data-dialog="custom"]');
  const picker = dlgFranchise.querySelector(".franchise-picker");
  const builder = dlgCustom.querySelector(".custom-picker");

  const currentSet = () => {
    if (choice.kind === "custom") return customSet(filter);
    if (choice.kind === "franchise") return franchiseSet(franchise);
    if (choice.setId === "random") return randomSet([...players.keys()].slice(0, RANDOM_N));
    return setById(choice.setId);
  };

  const selectedName = () => {
    if (choice.kind === "custom") return describe(withDefaults(filter));
    if (choice.kind === "franchise") return franchiseSet(franchise)?.name ?? "—";
    if (choice.setId === "random") return `${RANDOM_N} Random Players`;
    return setById(choice.setId)?.name ?? "—";
  };

  const update = () => {
    for (const btn of section.querySelectorAll("[data-open]")) {
      const active = btn.dataset.open === choice.kind;
      btn.classList.toggle("is-active", active);
      btn.querySelector(".choice-action").textContent = active ? "Change \u2192" : "Choose \u2192";
    }
    const n = idsForSet(currentSet()).length;
    const subs = {
      preset: "Curated star groups",
      franchise: "Every All-Star from one team",
      custom: "Build from awards, eras & more",
    };
    for (const [k, text] of Object.entries(subs)) {
      section.querySelector(`[data-sub="${k}"]`).textContent = text;
    }
    section.querySelector("[data-selection-summary]").innerHTML =
      `<span>Selected:</span> <strong>${escapeHtml(selectedName())}</strong> · ${n} players`;
    for (const el of form.querySelectorAll("[data-picks]")) {
      el.textContent = n < 2 ? "Need at least 2 players" : `Up to ${maxPicks(n, el.dataset.picks, TOP_K)} picks`;
    }
    startBtn.disabled = n < 2;
  };

  // ----- Preset dialog -----
  const openPreset = () => {
    const radios = dlgPreset.querySelectorAll('input[name="preset-set"]');
    radios.forEach((r) => (r.checked = choice.kind === "preset" && r.value === choice.setId));
    if (![...radios].some((r) => r.checked) && radios[0]) radios[0].checked = true;
    dlgPreset.showModal();
  };
  dlgPreset.querySelector("[data-dialog-confirm]").addEventListener("click", () => {
    const sel = dlgPreset.querySelector('input[name="preset-set"]:checked');
    if (sel) {
      choice = { kind: "preset", setId: sel.value };
      saveSelection(choice);
      update();
    }
    dlgPreset.close();
  });

  // ----- Team dialog -----
  const refreshFranchisePreview = () => renderCustomPreview(picker, idsForSet(franchiseSet(franchise)), "Try an earlier year.");
  // Re-render on team change (banner, former names); typing a year only refreshes counts
  // so the input keeps focus.
  const onFranchiseChange = (e) => {
    franchise = readFranchisePicker(picker);
    localStorage.setItem(FRANCHISE_KEY, JSON.stringify(franchise));
    const sub = picker.querySelector(".team-banner-sub");
    if (sub) sub.textContent = `All-Stars${franchise.since ? ` since ${franchise.since}` : ""}`;
    refreshFranchisePreview();
  };
  renderFranchisePicker(picker, franchise);
  picker.addEventListener("change", onFranchiseChange);
  picker.addEventListener("input", onFranchiseChange);
  picker.addEventListener(
    "toggle",
    (e) => {
      if (!e.target.matches(".team-select") || !e.target.open) return;
      e.target.querySelector(".team-option.is-selected")?.scrollIntoView({ block: "nearest" });
    },
    true
  );
  picker.addEventListener("click", (e) => {
    const option = e.target.closest("[data-team-id]");
    if (!option) return;
    franchise = { ...franchise, team: Number(option.dataset.teamId) };
    localStorage.setItem(FRANCHISE_KEY, JSON.stringify(franchise));
    renderFranchisePicker(picker, franchise);
    refreshFranchisePreview();
  });
  const openFranchise = () => {
    refreshFranchisePreview();
    dlgFranchise.showModal();
  };
  dlgFranchise.querySelector("[data-dialog-confirm]").addEventListener("click", () => {
    choice = { kind: "franchise" };
    saveSelection(choice);
    update();
    dlgFranchise.close();
  });

  // ----- Custom dialog -----
  const refreshCustomPreview = () => renderCustomPreview(builder, idsForSet(customSet(filter)));
  const onFilterChange = () => {
    filter = readCustomBuilder(builder);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(filter));
    refreshCustomPreview();
  };
  const rebuildCustom = () => {
    renderCustomBuilder(builder, filter);
    refreshCustomPreview();
  };
  builder.addEventListener("change", onFilterChange);
  builder.addEventListener("input", onFilterChange);
  builder.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-builder]");
    if (!btn) return;
    const action = btn.dataset.builder;
    if (action === "add") filter.rules.push(defaultRule());
    else if (action === "remove") filter.rules.splice(Number(btn.dataset.index), 1);
    else if (action === "example") filter = withDefaults(EXAMPLES[Number(btn.dataset.index)].filter);
    else if (action === "reset") filter = defaultFilter();
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(filter));
    rebuildCustom();
  });
  rebuildCustom();
  const openCustom = () => {
    refreshCustomPreview();
    dlgCustom.showModal();
  };
  dlgCustom.querySelector("[data-dialog-confirm]").addEventListener("click", () => {
    filter = readCustomBuilder(builder);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(filter));
    choice = { kind: "custom" };
    saveSelection(choice);
    update();
    dlgCustom.close();
  });

  // Open the matching dialog; close on Cancel or backdrop click.
  section.querySelector(".chooser").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open]");
    if (!btn) return;
    if (btn.dataset.open === "preset") openPreset();
    else if (btn.dataset.open === "franchise") openFranchise();
    else openCustom();
  });
  for (const dlg of [dlgPreset, dlgFranchise, dlgCustom]) {
    dlg.querySelector("[data-dialog-cancel]").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
  }

  update();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const isCustom = choice.kind === "custom";
    const isFranchise = choice.kind === "franchise";
    const isRandom = choice.kind === "preset" && choice.setId === "random";
    session = {
      id: newId(),
      createdAt: Date.now(),
      setId: isCustom ? "custom" : isFranchise ? "franchise" : choice.setId,
      ...(isCustom ? { filter: structuredClone(filter) } : {}),
      ...(isFranchise ? { franchise: { ...franchise } } : {}),
      ...(isRandom ? { ids: shuffle(randomPool(), Math.floor(Math.random() * 2 ** 31)).slice(0, RANDOM_N) } : {}),
      name: cleanName(form.rankingName.value),
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

function selectableFranchises() {
  return franchises().filter((f) => !/(Olympians|Bullets)$/.test(f.name));
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
    if (c && selectableFranchises().some((f) => f.id === c.team)) return { team: c.team, since: c.since || null };
  } catch {
    /* ignore */
  }
  return { team: DEFAULT_FRANCHISE, since: null };
}

// Unknown teams fall back to --team-fallback-* from the stylesheet.
function teamStyle(nick) {
  const c = TEAM_COLORS[nick];
  return c ? `--team-a:${c[0]};--team-b:${c[1]}` : "";
}

function renderFranchisePicker(el, choice) {
  const current = selectableFranchises().find((f) => f.id === choice.team);
  const nick = teamNickname(current?.name);
  el.innerHTML = `
    <div class="builder-section">
      <span class="builder-label">Franchise</span>
      <input type="hidden" data-f="team" value="${choice.team}" />
      <details class="team-select">
        <summary class="team-banner team-select-trigger" style="${teamStyle(nick)}">
          <span class="team-logo"><img src="https://cdn.nba.com/logos/nba/${choice.team}/primary/L/logo.svg" alt="" onerror="this.remove()" /></span>
          <span class="team-banner-text">
            <span class="team-banner-name">${escapeHtml(current?.name ?? "")}</span>
            <span class="team-banner-sub">All-Stars${choice.since ? ` since ${choice.since}` : ""}</span>
          </span>
          <span class="team-select-chevron" aria-hidden="true"></span>
        </summary>
        <div class="team-options" role="listbox" aria-label="Choose a franchise">
          ${selectableFranchises()
            .map((f) => {
              const selected = f.id === choice.team;
              return `<button type="button" class="team-option${selected ? " is-selected" : ""}" data-team-id="${f.id}"
                role="option" aria-selected="${selected}" aria-label="${escapeHtml(f.name)}">
                <span class="team-option-logo">
                  <img src="https://cdn.nba.com/logos/nba/${f.id}/primary/L/logo.svg" alt="" loading="lazy" onerror="this.remove()" />
                </span>
                <span class="team-option-name">${escapeHtml(f.name)}</span>
                <span class="team-option-check" aria-hidden="true">✓</span>
              </button>`;
            })
            .join("")}
        </div>
      </details>
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

// ---------- Season prediction ----------

function allScheduleSeasons() {
  return scheduleData?.seasons ?? [];
}

function predictionSeasons() {
  return allScheduleSeasons().filter((season) => season.predictionAvailable !== false);
}

function predictionSeason(id) {
  return predictionSeasons().find((season) => season.id === id);
}

function predictionTeams(season) {
  return Object.keys(season?.teamGameCounts ?? {}).sort((a, b) => a.localeCompare(b));
}

function gamesForTeam(season, team) {
  return (season?.games ?? []).filter((game) => game.homeTeam === team || game.awayTeam === team);
}

function completedGameWinner(game) {
  if (
    !Number.isFinite(game?.homeScore) ||
    !Number.isFinite(game?.awayScore) ||
    game.homeScore === game.awayScore
  ) {
    return null;
  }
  return game.homeScore > game.awayScore ? game.homeTeam : game.awayTeam;
}

function seriesForGames(games, team) {
  const series = new Map();
  games.forEach((game, scheduleIndex) => {
    const opponent = game.homeTeam === team ? game.awayTeam : game.homeTeam;
    if (!series.has(opponent)) {
      series.set(opponent, { opponent, games: [], scheduleIndex });
    }
    series.get(opponent).games.push(game);
  });
  return [...series.values()];
}

function predictionSeries(prediction, season, team = prediction.team) {
  return seriesForGames(
    gamesForTeam(season, team).filter((game) => !completedGameWinner(game)),
    team
  );
}

function syncCompletedGames(prediction, season) {
  const ungraded = new Set(
    Array.isArray(prediction.ungradedGameIds) ? prediction.ungradedGameIds : []
  );
  for (const game of season.games) {
    const winner = completedGameWinner(game);
    if (!winner || prediction.picks[game.id]) continue;
    prediction.picks[game.id] = winner;
    ungraded.add(game.id);
  }
  prediction.ungradedGameIds = [...ungraded].filter((gameId) =>
    season.games.some((game) => game.id === gameId)
  );
  return prediction;
}

function predictionIsComplete(prediction, games) {
  return games.every((game) => prediction.picks[game.id]);
}

function firstIncompleteSeriesIndex(series, picks) {
  const index = series.findIndex((matchup) => matchup.games.some((game) => !picks[game.id]));
  return index < 0 ? series.length : index;
}

function normalizePredictionProgress(prediction, season) {
  const series = predictionSeries(prediction, season);
  const firstIncomplete = firstIncompleteSeriesIndex(series, prediction.picks);
  if (prediction.flow !== "series") {
    prediction.flow = "series";
    prediction.index = firstIncomplete;
    return true;
  }
  if (prediction.index > firstIncomplete || prediction.index >= series.length) {
    prediction.index = firstIncomplete;
    return true;
  }
  return false;
}

function priorSeasonFor(season) {
  const startYear = Number(season?.id?.slice(0, 4)) - 1;
  if (!startYear) return null;
  const id = `${startYear}-${String(startYear + 1).slice(-2)}`;
  return allScheduleSeasons().find((item) => item.id === id) ?? null;
}

function actualTeamRecord(season, team, opponent) {
  const record = { wins: 0, losses: 0 };
  for (const game of gamesForTeam(season, team)) {
    if (
      opponent &&
      game.homeTeam !== opponent &&
      game.awayTeam !== opponent
    ) {
      continue;
    }
    if (game.homeScore == null || game.awayScore == null) continue;
    const teamScore = game.homeTeam === team ? game.homeScore : game.awayScore;
    const opponentScore = game.homeTeam === team ? game.awayScore : game.homeScore;
    record[teamScore > opponentScore ? "wins" : "losses"] += 1;
  }
  return record;
}

function predictionPerformance(prediction, games) {
  const ungraded = new Set(prediction.ungradedGameIds ?? []);
  let correct = 0;
  let completed = 0;
  let finals = 0;
  let excluded = 0;
  for (const game of games) {
    const winner = completedGameWinner(game);
    if (!winner) continue;
    finals += 1;
    if (ungraded.has(game.id)) {
      excluded += 1;
      continue;
    }
    const pick = prediction.picks[game.id];
    if (!pick) continue;
    completed += 1;
    if (pick === winner) correct += 1;
  }
  return {
    correct,
    completed,
    finals,
    excluded,
    accuracy: completed ? (correct / completed) * 100 : null,
  };
}

function predictionGameAssessment(prediction, game, team) {
  const winner = completedGameWinner(game);
  if (!winner) {
    return { status: "pending", label: "Pending", actual: "Awaiting final result" };
  }
  const home = game.homeTeam === team;
  const teamScore = home ? game.homeScore : game.awayScore;
  const opponentScore = home ? game.awayScore : game.homeScore;
  const actual = `Final ${winner === team ? "W" : "L"} · ${teamScore}-${opponentScore}`;
  if (prediction.ungradedGameIds?.includes(game.id)) {
    return { status: "excluded", label: "Excluded", actual };
  }
  const correct = prediction.picks[game.id] === winner;
  return {
    status: correct ? "correct" : "wrong",
    label: correct ? "Correct" : "Wrong",
    actual,
  };
}

function accuracyText(accuracy) {
  if (accuracy == null) return "—";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(accuracy)}%`;
}

function performanceText(performance) {
  return performance.completed
    ? `${performance.correct}/${performance.completed} correct · ${accuracyText(performance.accuracy)}`
    : performance.excluded
      ? `${performance.excluded} earlier result${performance.excluded === 1 ? "" : "s"} excluded`
      : "No games final yet";
}

function predictionPerformanceMarkup(performance) {
  const updated = scheduleData?.generatedAt
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(scheduleData.generatedAt))
    : "";
  return `
    <section class="prediction-performance" aria-label="Prediction performance so far">
      <div><span>Accuracy</span><strong>${accuracyText(performance.accuracy)}</strong></div>
      <div><span>Correct picks</span><strong>${performance.correct}</strong></div>
      <div><span>Picks graded</span><strong>${performance.completed}</strong></div>
      <p>${
        performance.completed
          ? `Graded against ${performance.completed} eligible final game${performance.completed === 1 ? "" : "s"}${
              performance.excluded
                ? ` · ${performance.excluded} earlier result${performance.excluded === 1 ? "" : "s"} excluded`
                : ""
            }${updated ? ` · Results updated ${escapeHtml(updated)}` : ""}.`
          : performance.excluded
            ? `${performance.excluded} completed game${performance.excluded === 1 ? "" : "s"} predated this prediction and ${
                performance.excluded === 1 ? "is" : "are"
              } excluded from scoring${updated ? ` · Results updated ${escapeHtml(updated)}` : ""}.`
            : `No regular-season games have final results yet${updated ? ` · Schedule data updated ${escapeHtml(updated)}` : ""}.`
      }</p>
    </section>`;
}

function franchiseForTeam(name) {
  return selectableFranchises().find((franchise) => franchise.name === name);
}

function teamLogoUrl(name) {
  const franchise = franchiseForTeam(name);
  return franchise ? `https://cdn.nba.com/logos/nba/${franchise.id}/primary/L/logo.svg` : "";
}

function teamLogo(name, className = "prediction-logo") {
  const url = teamLogoUrl(name);
  return `<span class="${className}">${
    url ? `<img src="${url}" alt="" loading="lazy" onerror="this.remove()" />` : ""
  }</span>`;
}

function predictionTeamPicker(team, season) {
  const names = predictionTeams(season);
  return `
    <details class="team-select prediction-team-select">
      <summary class="team-banner team-select-trigger" style="${teamStyle(teamNickname(team))}">
        ${teamLogo(team, "team-logo")}
        <span class="team-banner-text">
          <span class="team-banner-name">${escapeHtml(team)}</span>
          <span class="team-banner-sub">${season.label} schedule</span>
        </span>
        <span class="team-select-chevron" aria-hidden="true"></span>
      </summary>
      <div class="team-options" role="listbox" aria-label="Choose a team">
        ${names
          .map((name) => {
            const selected = name === team;
            return `<button type="button" class="team-option${selected ? " is-selected" : ""}"
              data-prediction-team="${escapeHtml(name)}" role="option" aria-selected="${selected}"
              aria-label="${escapeHtml(name)}">
              ${teamLogo(name, "team-option-logo")}
              <span class="team-option-name">${escapeHtml(name)}</span>
              <span class="team-option-check" aria-hidden="true">✓</span>
            </button>`;
          })
          .join("")}
      </div>
    </details>`;
}

function normalizePrediction(prediction) {
  const season = predictionSeason(prediction?.seasonId);
  if (
    !season ||
    !predictionTeams(season).includes(prediction?.team) ||
    !prediction?.picks ||
    typeof prediction.picks !== "object" ||
    !Number.isInteger(prediction.index)
  ) {
    return null;
  }
  const games = new Map(season.games.map((game) => [game.id, game]));
  const picks = {};
  Object.entries(prediction.picks).forEach(([gameId, winner]) => {
    const game = games.get(gameId);
    if (game && (winner === game.homeTeam || winner === game.awayTeam)) {
      picks[gameId] = winner;
    }
  });
  return syncCompletedGames(
    {
      ...prediction,
      name: cleanName(prediction.name),
      picks,
      ungradedGameIds: Array.isArray(prediction.ungradedGameIds)
        ? prediction.ungradedGameIds.filter((gameId) => games.has(gameId))
        : [],
      createdAt: Number.isFinite(prediction.createdAt)
        ? prediction.createdAt
        : Number.isFinite(prediction.updatedAt)
          ? prediction.updatedAt
          : Date.now(),
      updatedAt: Number.isFinite(prediction.updatedAt) ? prediction.updatedAt : Date.now(),
    },
    season
  );
}

function createPrediction(season, team, name = "") {
  const now = Date.now();
  return syncCompletedGames(
    {
      name: cleanName(name),
      seasonId: season.id,
      team,
      picks: {},
      ungradedGameIds: [],
      index: 0,
      flow: "series",
      createdAt: now,
      updatedAt: now,
    },
    season
  );
}

function predictionIdentifier(prediction) {
  return `${prediction.seasonId}|${prediction.team}`;
}

function loadPrediction() {
  try {
    const prediction = normalizePrediction(JSON.parse(localStorage.getItem(PREDICTION_KEY)));
    if (prediction) {
      localStorage.setItem(PREDICTION_KEY, JSON.stringify(prediction));
      return prediction;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function loadPredictions() {
  let predictions = [];
  try {
    const stored = JSON.parse(localStorage.getItem(PREDICTIONS_KEY));
    if (Array.isArray(stored)) predictions = stored.map(normalizePrediction).filter(Boolean);
  } catch {
    /* ignore */
  }
  const active = loadPrediction();
  if (active) predictions.push(active);
  const unique = new Map();
  predictions.forEach((prediction) => {
    const id = predictionIdentifier(prediction);
    const existing = unique.get(id);
    if (!existing || (prediction.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
      unique.set(id, prediction);
    }
  });
  const saved = [...unique.values()].sort(
    (a, b) => a.team.localeCompare(b.team) || a.seasonId.localeCompare(b.seasonId)
  );
  localStorage.setItem(PREDICTIONS_KEY, JSON.stringify(saved));
  return saved;
}

function activatePrediction(prediction) {
  const normalized = normalizePrediction(prediction);
  if (normalized) localStorage.setItem(PREDICTION_KEY, JSON.stringify(normalized));
}

function savePrediction(prediction) {
  const normalized = normalizePrediction(prediction);
  if (!normalized) return null;
  activatePrediction(normalized);
  const predictions = loadPredictions().filter(
    (saved) => predictionIdentifier(saved) !== predictionIdentifier(normalized)
  );
  predictions.push(normalized);
  predictions.sort((a, b) => a.team.localeCompare(b.team) || a.seasonId.localeCompare(b.seasonId));
  localStorage.setItem(PREDICTIONS_KEY, JSON.stringify(predictions));
  return normalized;
}

function deletePrediction(prediction) {
  const id = predictionIdentifier(prediction);
  const predictions = loadPredictions().filter((saved) => predictionIdentifier(saved) !== id);
  localStorage.setItem(PREDICTIONS_KEY, JSON.stringify(predictions));
  const active = loadPrediction();
  if (active && predictionIdentifier(active) === id) localStorage.removeItem(PREDICTION_KEY);
}

function renamePrediction(prediction, name) {
  const renamed = { ...prediction, name, updatedAt: Date.now() };
  const id = predictionIdentifier(prediction);
  const predictions = loadPredictions().map((saved) =>
    predictionIdentifier(saved) === id ? renamed : saved
  );
  localStorage.setItem(PREDICTIONS_KEY, JSON.stringify(predictions));
  if (predictionIdentifier(loadPrediction() ?? {}) === id) activatePrediction(renamed);
}

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function exportPredictions(predictions, fileName, includeLeague = false) {
  downloadJson(
    {
      app: "nba-ranker",
      version: 1,
      type: includeLeague
        ? "prediction-data"
        : predictions.length === 1
          ? "season-prediction"
          : "season-predictions",
      exportedAt: new Date().toISOString(),
      predictions,
      ...(includeLeague ? { leaguePredictions: loadLeaguePredictions() } : {}),
    },
    fileName
  );
}

function normalizeLeaguePrediction(prediction) {
  const season = predictionSeason(prediction?.seasonId);
  if (!season || !prediction.picks || typeof prediction.picks !== "object") return null;
  const games = new Map(season.games.map((game) => [game.id, game]));
  const picks = {};
  Object.entries(prediction.picks).forEach(([gameId, winner]) => {
    const game = games.get(gameId);
    if (game && (winner === game.homeTeam || winner === game.awayTeam)) picks[gameId] = winner;
  });
  const updatedAt = Number.isFinite(prediction.updatedAt) ? prediction.updatedAt : Date.now();
  return syncCompletedGames(
    {
      id: prediction.id ?? `league-${season.id}-${updatedAt}`,
      name: cleanName(prediction.name),
      seasonId: season.id,
      picks,
      ungradedGameIds: Array.isArray(prediction.ungradedGameIds)
        ? prediction.ungradedGameIds.filter((gameId) => games.has(gameId))
        : [],
      activeTeam: prediction.activeTeam ?? null,
      seriesIndex: Number.isInteger(prediction.seriesIndex) ? prediction.seriesIndex : 0,
      createdAt: Number.isFinite(prediction.createdAt) ? prediction.createdAt : updatedAt,
      updatedAt,
    },
    season
  );
}

function loadLeaguePrediction() {
  try {
    return normalizeLeaguePrediction(JSON.parse(localStorage.getItem(LEAGUE_PREDICTION_KEY)));
  } catch {
    return null;
  }
}

function saveLeaguePrediction(prediction) {
  const normalized = normalizeLeaguePrediction(prediction);
  if (!normalized) return null;
  localStorage.setItem(LEAGUE_PREDICTION_KEY, JSON.stringify(normalized));
  const predictions = loadLeaguePredictions().filter((saved) => saved.id !== normalized.id);
  predictions.push(normalized);
  predictions.sort((a, b) => b.updatedAt - a.updatedAt);
  localStorage.setItem(LEAGUE_PREDICTIONS_KEY, JSON.stringify(predictions));
  return normalized;
}

function loadLeaguePredictions() {
  let saved = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(LEAGUE_PREDICTIONS_KEY));
    if (Array.isArray(parsed)) saved = parsed.map(normalizeLeaguePrediction).filter(Boolean);
  } catch {
    saved = [];
  }
  if (!saved.length) {
    const legacy = loadLeaguePrediction();
    if (legacy) saved = [legacy];
  }
  const unique = [...new Map(saved.map((prediction) => [prediction.id, prediction])).values()].sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  if (unique.length) localStorage.setItem(LEAGUE_PREDICTIONS_KEY, JSON.stringify(unique));
  return unique;
}

function activateLeaguePrediction(prediction) {
  localStorage.setItem(LEAGUE_PREDICTION_KEY, JSON.stringify(prediction));
}

function createLeaguePrediction(season, name = "") {
  const now = Date.now();
  return syncCompletedGames(
    {
      id: crypto.randomUUID?.() ?? `league-${season.id}-${now}-${Math.random().toString(36).slice(2)}`,
      name: cleanName(name),
      seasonId: season.id,
      picks: {},
      ungradedGameIds: [],
      activeTeam: null,
      seriesIndex: 0,
      createdAt: now,
      updatedAt: now,
    },
    season
  );
}

function startNewLeaguePrediction(name = "") {
  const season = predictionSeasons()[0];
  if (!season) return null;
  return saveLeaguePrediction(createLeaguePrediction(season, name));
}

function deleteLeaguePrediction(id) {
  const predictions = loadLeaguePredictions().filter((prediction) => prediction.id !== id);
  localStorage.setItem(LEAGUE_PREDICTIONS_KEY, JSON.stringify(predictions));
  if (loadLeaguePrediction()?.id === id) localStorage.removeItem(LEAGUE_PREDICTION_KEY);
}

function renameLeaguePrediction(prediction, name) {
  const renamed = { ...prediction, name, updatedAt: Date.now() };
  const predictions = loadLeaguePredictions()
    .map((saved) => (saved.id === renamed.id ? renamed : saved))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  localStorage.setItem(LEAGUE_PREDICTIONS_KEY, JSON.stringify(predictions));
  if (loadLeaguePrediction()?.id === renamed.id) activateLeaguePrediction(renamed);
}

function exportLeaguePrediction(prediction) {
  downloadJson(
    {
      app: "nba-ranker",
      version: 1,
      type: "league-prediction",
      exportedAt: new Date().toISOString(),
      leaguePrediction: prediction,
    },
    `nba-${prediction.seasonId}-league-prediction.json`
  );
}

async function importPredictionData(file) {
  if (file.size > 5_000_000) throw new Error("That file is too large.");
  const data = JSON.parse(await file.text());
  if (data?.app !== "nba-ranker") throw new Error("That isn't an NBA Ranker export.");
  let imported = 0;
  if (Array.isArray(data.predictions)) {
    const merged = new Map(loadPredictions().map((prediction) => [predictionIdentifier(prediction), prediction]));
    data.predictions.map(normalizePrediction).filter(Boolean).forEach((prediction) => {
      merged.set(predictionIdentifier(prediction), prediction);
      imported += 1;
    });
    localStorage.setItem(
      PREDICTIONS_KEY,
      JSON.stringify(
        [...merged.values()].sort(
          (a, b) => a.team.localeCompare(b.team) || a.seasonId.localeCompare(b.seasonId)
        )
      )
    );
  }
  const leagueData = Array.isArray(data.leaguePredictions)
    ? data.leaguePredictions
    : data.leaguePrediction
      ? [data.leaguePrediction]
      : [];
  const leaguePredictions = new Map(
    loadLeaguePredictions().map((prediction) => [prediction.id, prediction])
  );
  let activeLeaguePrediction = null;
  leagueData.map(normalizeLeaguePrediction).filter(Boolean).forEach((prediction) => {
    leaguePredictions.set(prediction.id, prediction);
    activeLeaguePrediction = prediction;
    imported += 1;
  });
  if (activeLeaguePrediction) {
    localStorage.setItem(
      LEAGUE_PREDICTIONS_KEY,
      JSON.stringify([...leaguePredictions.values()].sort((a, b) => b.updatedAt - a.updatedAt))
    );
    activateLeaguePrediction(activeLeaguePrediction);
  }
  if (!imported) throw new Error("No valid prediction data was found.");
  return `Imported ${imported} prediction${imported === 1 ? "" : "s"}.`;
}

function seedLeaguePrediction(season) {
  const params = new URLSearchParams(location.search);
  const seed = params.get("seed-league");
  if (seed !== "half" && seed !== "full") return null;
  const games =
    seed === "full"
      ? season.games
      : season.games.slice(0, Math.ceil(season.games.length / 2));
  const prediction = createLeaguePrediction(season);
  prediction.id = loadLeaguePrediction()?.id ?? prediction.id;
  games.forEach((game, index) => {
    if (completedGameWinner(game)) return;
    prediction.picks[game.id] = index % 3 === 0 ? game.awayTeam : game.homeTeam;
  });
  prediction.updatedAt = Date.now();
  saveLeaguePrediction(prediction);
  params.delete("seed-league");
  const query = params.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${query ? `?${query}` : ""}${location.hash}`
  );
  return prediction;
}

function currentLeaguePrediction() {
  const season = predictionSeasons()[0];
  if (!season) return null;
  const seeded = seedLeaguePrediction(season);
  if (seeded) return seeded;
  const saved = loadLeaguePrediction();
  if (saved?.seasonId === season.id) return saved;
  return createLeaguePrediction(season);
}

function renderPredictionMode() {
  setKeys(null);
  const leaguePrediction = currentLeaguePrediction();
  const season = predictionSeason(leaguePrediction?.seasonId);
  const totalGames = season?.games.length ?? 0;
  const pickedGames = season
    ? season.games.filter((game) => leaguePrediction.picks[game.id]).length
    : 0;
  app.innerHTML = `
    <section class="prediction-mode">
      <a class="back-link" href="./">&larr; All features</a>
      <h1>Choose a prediction challenge.</h1>
      <p class="lede">Focus on one team's season, or predict every game across the entire NBA.</p>
      <div class="prediction-mode-grid feature-grid">
        <a class="prediction-mode-card feature-card" href="#season-prediction/team">
          <span class="feature-kicker">One team</span>
          <strong>Predict a specific team</strong>
          <span>Work through one team's opponent series and finish with its complete predicted record.</span>
          <span class="feature-action">Choose a team &rarr;</span>
        </a>
        <a class="prediction-mode-card feature-card" href="#season-prediction/league/library">
          <span class="feature-kicker">Entire NBA</span>
          <strong>Predict the full season</strong>
          <span>Pick winners across all 30 teams. Shared games update both teams automatically.</span>
          ${
            totalGames
              ? `<span class="prediction-mode-progress">${pickedGames} of ${totalGames} games predicted</span>`
              : ""
          }
          <span class="feature-action">View full-league predictions &rarr;</span>
        </a>
      </div>
    </section>`;
}

function scheduleStatus(season) {
  if (season.complete) return `Full ${season.expectedGamesPerTeam}-game regular-season schedule`;
  const missing = season.expectedGamesPerTeam - season.knownGamesPerTeam;
  return `${season.knownGamesPerTeam} scheduled games · ${missing} will be added after NBA Cup scheduling`;
}

function predictionDataFileName(prediction) {
  const team = prediction.team.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${team}-${prediction.seasonId}-prediction.json`;
}

function savedPredictionCard(prediction) {
  const season = predictionSeason(prediction.seasonId);
  const games = gamesForTeam(season, prediction.team);
  const series = predictionSeries(prediction, season);
  const complete = predictionIsComplete(prediction, games);
  const pickedGames = games.filter((game) => prediction.picks[game.id]).length;
  const seriesIndex = Math.min(
    prediction.index,
    firstIncompleteSeriesIndex(series, prediction.picks)
  );
  const records = predictionRecords(prediction, season);
  const performance = predictionPerformance(prediction, games);
  const id = escapeHtml(predictionIdentifier(prediction));
  return `
    <article class="saved-prediction" style="${teamStyle(teamNickname(prediction.team))}">
      <div class="saved-prediction-team">
        ${teamLogo(prediction.team, "saved-prediction-logo")}
        <span>
          <span class="prediction-card-title-row">
            <strong>${escapeHtml(teamPredictionTitle(prediction))}</strong>
            ${
              complete
                ? `<button type="button" class="icon-btn edit" data-prediction-action="edit"
                    data-prediction-id="${id}" aria-label="Edit name" title="Edit name">${EDIT_ICON}</button>`
                : ""
            }
          </span>
          <small>${escapeHtml(`${prediction.team} · ${season.label}`)}</small>
        </span>
      </div>
      <div class="saved-prediction-status">
        <strong>${complete ? recordText(records.overall) : `${pickedGames}/${games.length}`}</strong>
        <span>${complete ? "Final prediction" : `Series ${seriesIndex + 1} of ${series.length}`}</span>
      </div>
      ${
        complete
          ? `<div class="saved-performance-label"><b>Season score</b><span>${performanceText(performance)}</span></div>`
          : ""
      }
      <div class="saved-prediction-actions">
        <button type="button" class="btn primary small" data-prediction-action="open" data-prediction-id="${id}">
          ${complete ? "View results" : "Resume"}
        </button>
        <button type="button" class="btn ghost small" data-prediction-action="export" data-prediction-id="${id}">Export</button>
        <button type="button" class="btn ghost small" data-prediction-action="delete" data-prediction-id="${id}">Delete</button>
      </div>
    </article>`;
}

function savedPredictionsMarkup(predictions) {
  return predictions.length
    ? `<div class="saved-predictions-list">${predictions.map(savedPredictionCard).join("")}</div>
       ${nameDialog("prediction")}`
    : `<div class="saved-empty"><p>No saved season predictions yet.</p></div>`;
}

function bindPredictionLibrary(root, predictions, onDelete) {
  const predictionsById = new Map(
    predictions.map((prediction) => [predictionIdentifier(prediction), prediction])
  );
  const dialog = root.querySelector('[data-name-dialog="prediction"]');
  let renameTarget = null;
  root.addEventListener("click", (event) => {
    const action = event.target.closest("[data-prediction-action]");
    if (!action) return;
    const prediction = predictionsById.get(action.dataset.predictionId);
    if (!prediction) return;
    if (action.dataset.predictionAction === "open") {
      activatePrediction(prediction);
      const predictionGames = gamesForTeam(predictionSeason(prediction.seasonId), prediction.team);
      location.hash = predictionIsComplete(prediction, predictionGames)
        ? "#season-prediction/results"
        : "#season-prediction/play";
    } else if (action.dataset.predictionAction === "edit") {
      renameTarget = prediction;
      openNameDialog(dialog, prediction.name ?? "", teamPredictionTitle(prediction));
    } else if (action.dataset.predictionAction === "export") {
      exportPredictions([prediction], predictionDataFileName(prediction));
    } else if (action.dataset.predictionAction === "delete") {
      if (!confirm(`Delete the ${prediction.team} prediction?`)) return;
      deletePrediction(prediction);
      onDelete();
    }
  });
  bindNameDialog(dialog, (name) => {
    if (!renameTarget) return;
    renamePrediction(renameTarget, name);
    onDelete();
  });
  root.querySelector("[data-export-all-predictions]")?.addEventListener("click", () => {
    exportPredictions(predictions, "nba-prediction-data.json", true);
  });
}

function renderPredictionSetup(selectedSeasonId, selectedTeam) {
  setKeys(null);
  const active = loadPrediction();
  const savedPredictions = loadPredictions();
  const seasons = predictionSeasons();
  const season =
    predictionSeason(selectedSeasonId) ??
    predictionSeason(active?.seasonId) ??
    seasons[0];

  if (!season) {
    app.innerHTML = `<p class="error">Season schedule data is unavailable.</p>`;
    return;
  }

  const teams = predictionTeams(season);
  const team = teams.includes(selectedTeam)
    ? selectedTeam
    : teams.includes(active?.team) && active?.seasonId === season.id
      ? active.team
      : teams.includes("Los Angeles Lakers")
        ? "Los Angeles Lakers"
        : teams[0];
  const matchingSaved = savedPredictions.find(
    (prediction) => prediction.seasonId === season.id && prediction.team === team
  );
  const completedTeamGames = gamesForTeam(season, team).filter(completedGameWinner).length;
  const savedGames = matchingSaved ? gamesForTeam(season, team) : [];
  const savedSeries = matchingSaved ? predictionSeries(matchingSaved, season) : [];
  const savedComplete = matchingSaved && predictionIsComplete(matchingSaved, savedGames);
  const savedSeriesIndex = matchingSaved
    ? Math.min(
        matchingSaved.index,
        firstIncompleteSeriesIndex(savedSeries, matchingSaved.picks)
      )
    : 0;

  app.innerHTML = `
    <section class="prediction-setup">
      <a class="back-link" href="#season-prediction">&larr; Prediction modes</a>
      <h1>Predict a team's season.</h1>
      <p class="lede">Predict every game against one opponent at a time, then see the record you called at home, away, and across the league.</p>
      <div class="prediction-config">
        <label class="prediction-field">
          <span>Season</span>
          ${
            seasons.length > 1
              ? `<select data-prediction-season>
                  ${seasons
                    .map(
                      (item) =>
                        `<option value="${item.id}" ${item.id === season.id ? "selected" : ""}>${item.label}</option>`
                    )
                    .join("")}
                </select>`
              : `<span class="season-display">${season.label} <small>Upcoming season</small></span>`
          }
        </label>
        <div class="prediction-field">
          <span>Team</span>
          ${predictionTeamPicker(team, season)}
        </div>
        <label class="prediction-field prediction-name-field">
          <span>Prediction name <small>Optional</small></span>
          <input type="text" maxlength="80" autocomplete="off" data-prediction-name
            value="${escapeHtml(matchingSaved?.name ?? "")}"
            placeholder="e.g. Pistons breakout season" />
        </label>
        <p class="schedule-status${season.complete ? "" : " is-partial"}">${escapeHtml(scheduleStatus(season))}</p>
        ${
          completedTeamGames
            ? `<p class="schedule-status">Starting now will add ${completedTeamGames} completed game${
                completedTeamGames === 1 ? "" : "s"
              } as actual results and exclude ${completedTeamGames === 1 ? "it" : "them"} from scoring.</p>`
            : ""
        }
      </div>
      <button type="button" class="btn primary big prediction-start" data-start-prediction>
        ${matchingSaved ? (savedComplete ? "View results" : `Resume series ${savedSeriesIndex + 1}`) : "Start prediction"}
      </button>
      <section class="saved-predictions">
        <div class="saved-predictions-heading">
          <div>
            <h2>Saved predictions</h2>
            <p>Sorted alphabetically by team.</p>
          </div>
          <button type="button" class="btn ghost small" data-export-all-predictions
            ${savedPredictions.length ? "" : "disabled"}>Export all data</button>
        </div>
        ${savedPredictionsMarkup(savedPredictions)}
      </section>
    </section>`;

  app.querySelector("[data-prediction-season]")?.addEventListener("change", (e) => {
    renderPredictionSetup(e.target.value);
  });
  app.querySelector(".prediction-team-select").addEventListener(
    "toggle",
    (e) => {
      if (!e.target.open) return;
      e.target.querySelector(".team-option.is-selected")?.scrollIntoView({ block: "nearest" });
    },
    true
  );
  app.querySelector(".prediction-team-select").addEventListener("click", (e) => {
    const option = e.target.closest("[data-prediction-team]");
    if (!option) return;
    renderPredictionSetup(season.id, option.dataset.predictionTeam);
  });
  app.querySelector("[data-start-prediction]").addEventListener("click", () => {
    const name = cleanName(app.querySelector("[data-prediction-name]").value);
    if (!matchingSaved) {
      savePrediction(createPrediction(season, team, name));
    } else {
      matchingSaved.name = name;
      matchingSaved.updatedAt = Date.now();
      savePrediction(matchingSaved);
    }
    location.hash = savedComplete ? "#season-prediction/results" : "#season-prediction/play";
  });
  bindPredictionLibrary(app.querySelector(".saved-predictions"), savedPredictions, () => {
    renderPredictionSetup(season.id, team);
  });
}

function savedLeaguePredictionCard(prediction) {
  const season = predictionSeason(prediction.seasonId);
  const pickedGames = season.games.filter((game) => prediction.picks[game.id]).length;
  const complete = leaguePredictionIsComplete(prediction, season);
  const progress = Math.round((pickedGames / season.games.length) * 100);
  const performance = predictionPerformance(prediction, season.games);
  const updated = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(prediction.updatedAt));
  return `
    <article class="saved-league-prediction" data-league-prediction="${escapeHtml(prediction.id)}">
      <div>
        <span class="results-kicker">${escapeHtml(season.label)}</span>
        <div class="prediction-card-title-row">
          <h2>${escapeHtml(leaguePredictionTitle(prediction))}</h2>
          ${
            complete
              ? `<button type="button" class="icon-btn edit" data-edit-league
                  aria-label="Edit name" title="Edit name">${EDIT_ICON}</button>`
              : ""
          }
        </div>
        ${
          complete
            ? `<div class="saved-performance-label"><b>Season score</b><span>${performanceText(performance)}</span></div>`
            : `<p>${pickedGames} of ${season.games.length} games predicted · ${progress}% complete</p>`
        }
        <small>Updated ${escapeHtml(updated)}</small>
      </div>
      <div class="saved-league-progress" aria-hidden="true"><span style="width:${progress}%"></span></div>
      <div class="saved-prediction-actions">
        <button type="button" class="btn primary small" data-open-league
          data-league-destination="${complete ? "#season-prediction/league/results" : "#season-prediction/league"}">
          ${complete ? "View standings" : "Continue"}
        </button>
        <button type="button" class="btn ghost small" data-export-league>Export</button>
        <button type="button" class="btn ghost small" data-delete-league>Delete</button>
      </div>
    </article>`;
}

function leaguePredictionIsComplete(prediction, season = predictionSeason(prediction?.seasonId)) {
  return Boolean(prediction && season && season.games.every((game) => prediction.picks[game.id]));
}

function bindLeaguePredictionLibrary(root, predictions, onDelete) {
  const dialog = root?.querySelector('[data-name-dialog="league"]');
  let renameTarget = null;
  root?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-league-prediction]");
    if (!card) return;
    const prediction = predictions.find((saved) => saved.id === card.dataset.leaguePrediction);
    if (!prediction) return;
    if (event.target.closest("[data-open-league]")) {
      activateLeaguePrediction(prediction);
      location.hash = event.target.closest("[data-open-league]").dataset.leagueDestination;
    } else if (event.target.closest("[data-edit-league]")) {
      renameTarget = prediction;
      openNameDialog(dialog, prediction.name ?? "", leaguePredictionTitle(prediction));
    } else if (event.target.closest("[data-export-league]")) {
      exportLeaguePrediction(prediction);
    } else if (event.target.closest("[data-delete-league]")) {
      if (!confirm("Delete this full-league prediction?")) return;
      deleteLeaguePrediction(prediction.id);
      onDelete();
    }
  });
  bindNameDialog(dialog, (name) => {
    if (!renameTarget) return;
    renameLeaguePrediction(renameTarget, name);
    onDelete();
  });
}

function renderLeaguePredictionLibrary() {
  setKeys(null);
  const predictions = loadLeaguePredictions();
  const isComplete = (prediction) => {
    const season = predictionSeason(prediction.seasonId);
    return season && season.games.every((game) => prediction.picks[game.id]);
  };
  const inProgress = predictions.filter((prediction) => !isComplete(prediction));
  const finished = predictions.filter(isComplete);
  const section = (title, items, emptyText) => `
    <section class="league-library-section">
      <div class="league-library-section-heading">
        <h2>${title}</h2>
        <span>${items.length}</span>
      </div>
      ${
        items.length
          ? `<div class="saved-league-predictions">${items.map(savedLeaguePredictionCard).join("")}</div>`
          : `<p class="saved-empty">${emptyText}</p>`
      }
    </section>`;

  app.innerHTML = `
    <section class="league-prediction-library">
      <a class="back-link" href="#season-prediction">&larr; Prediction modes</a>
      <div class="league-library-heading">
        <div>
          <span class="results-kicker">Entire NBA</span>
          <h1>Full-league predictions</h1>
          <p class="lede">Continue a season in progress or revisit completed standings.</p>
        </div>
        <form class="league-new-prediction-form" data-new-league-form>
          <label class="name-field">
            <span>Prediction name <small>Optional</small></span>
            <input type="text" maxlength="80" autocomplete="off" data-new-league-name
              placeholder="e.g. My chaos season" />
          </label>
          <button type="submit" class="btn primary">Start a new full season</button>
        </form>
      </div>
      ${section("In progress", inProgress, "No full-league predictions are currently in progress.")}
      ${section("Finished", finished, "No full-league predictions have been completed yet.")}
      ${nameDialog("league")}
    </section>`;

  app.querySelector("[data-new-league-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = app.querySelector("[data-new-league-name]").value;
    if (!startNewLeaguePrediction(name)) return;
    location.hash = "#season-prediction/league";
  });
  bindLeaguePredictionLibrary(
    app.querySelector(".league-prediction-library"),
    predictions,
    renderLeaguePredictionLibrary
  );
}

function renderMyPredictions(status = "", tab = null) {
  setKeys(null);
  const predictions = loadPredictions();
  const leaguePredictions = loadLeaguePredictions();
  const activeTab =
    tab === "team" || tab === "league"
      ? tab
      : predictions.length || !leaguePredictions.length
        ? "team"
        : "league";
  app.innerHTML = `
    <section class="my-predictions">
      <h1>My Predictions</h1>
      <p class="lede">Saved team and full-league season predictions.</p>
      <div class="prediction-library-toolbar">
        <a class="btn primary small" href="#season-prediction">+ New prediction</a>
        <a class="btn small" href="#season-prediction/league/library">+ New full season</a>
        <button type="button" class="btn ghost small" data-export-all-predictions
          ${predictions.length || leaguePredictions.length ? "" : "disabled"}>Export all data</button>
        <label class="btn ghost small file-btn">Import
          <input type="file" accept=".json,application/json" data-import-predictions />
        </label>
        <span class="backup-status" role="status">${escapeHtml(status)}</span>
      </div>
      <div class="tabs prediction-library-tabs" role="tablist">
        <a role="tab" class="tab" href="#my-predictions/team"
          aria-selected="${activeTab === "team"}">Team <span class="tab-count">${predictions.length}</span></a>
        <a role="tab" class="tab" href="#my-predictions/league"
          aria-selected="${activeTab === "league"}">Full league <span class="tab-count">${leaguePredictions.length}</span></a>
      </div>
      ${
        activeTab === "league"
          ? `<section class="saved-league-section">
              <h2>Full league</h2>
              <p>Each full-season prediction is saved separately.</p>
              ${
                leaguePredictions.length
                  ? `<div class="saved-league-predictions">
                      ${leaguePredictions.map(savedLeaguePredictionCard).join("")}
                    </div>`
                  : `<div class="saved-empty"><p>No saved full-league predictions yet.</p></div>`
              }
              ${nameDialog("league")}
            </section>`
          : `<section class="saved-team-predictions">
              <h2>Team predictions</h2>
              <p>Sorted alphabetically by team.</p>
              ${savedPredictionsMarkup(predictions)}
            </section>`
      }
    </section>`;
  bindPredictionLibrary(app.querySelector(".my-predictions"), predictions, () =>
    renderMyPredictions("", activeTab)
  );
  bindLeaguePredictionLibrary(
    app.querySelector(".saved-league-section"),
    leaguePredictions,
    () => renderMyPredictions("", activeTab)
  );
  app.querySelector("[data-import-predictions]").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      renderMyPredictions(await importPredictionData(file), activeTab);
    } catch (error) {
      renderMyPredictions(error.message, activeTab);
    }
  });
}

function leagueTeamCard(prediction, season, team) {
  const games = gamesForTeam(season, team);
  const pickedGames = games.filter((game) => prediction.picks[game.id]).length;
  const records = predictionRecords({ team, picks: prediction.picks }, season);
  const progress = Math.round((pickedGames / games.length) * 100);
  return `
    <button type="button" class="league-team-card${pickedGames === games.length ? " is-complete" : ""}"
      data-league-team="${escapeHtml(team)}" style="${teamStyle(teamNickname(team))}">
      <span class="league-team-head">
        ${teamLogo(team, "league-team-logo")}
        <span>
          <strong>${escapeHtml(team)}</strong>
          <small>${recordText(records.overall)} predicted record</small>
        </span>
      </span>
      <span class="league-team-progress">
        <span><b>${pickedGames}</b> of ${games.length} games</span>
        <span>${pickedGames === games.length ? "Complete" : `${progress}%`}</span>
      </span>
      <span class="league-team-progress-track" aria-hidden="true"><span style="width:${progress}%"></span></span>
    </button>`;
}

function renderLeaguePredictionHub() {
  setKeys(null);
  const prediction = currentLeaguePrediction();
  const season = predictionSeason(prediction?.seasonId);
  if (!prediction || !season) {
    app.innerHTML = `<p class="error">Season schedule data is unavailable.</p>`;
    return;
  }
  if (leaguePredictionIsComplete(prediction, season)) {
    location.hash = "#season-prediction/league/results";
    return;
  }
  const teamCompletion = new Map(
    predictionTeams(season).map((team) => {
      const games = gamesForTeam(season, team);
      const pickedGames = games.filter((game) => prediction.picks[game.id]).length;
      return [team, games.length ? pickedGames / games.length : 0];
    })
  );
  const teams = [...teamCompletion.keys()].sort(
    (a, b) => teamCompletion.get(b) - teamCompletion.get(a) || a.localeCompare(b)
  );
  const pickedGames = season.games.filter((game) => prediction.picks[game.id]).length;
  const progress = Math.round((pickedGames / season.games.length) * 1000) / 10;
  app.innerHTML = `
    <section class="league-prediction">
      <a class="back-link" href="#season-prediction">&larr; Prediction modes</a>
      <div class="league-prediction-heading">
        <div>
          <span class="results-kicker">${escapeHtml(season.label)}</span>
          <h1>Predict the entire NBA season.</h1>
          <p class="lede">Choose any team. Every result is shared with its opponent, so the whole league fills in together.</p>
        </div>
        <div class="league-total-progress">
          <strong>${pickedGames}</strong>
          <span>of ${season.games.length} games</span>
          <b>${progress}% complete</b>
        </div>
      </div>
      <div class="progress-track league-progress-track" aria-hidden="true"><span style="width:${progress}%"></span></div>
      ${
        season.complete
          ? ""
          : `<p class="schedule-status is-partial league-schedule-status">${escapeHtml(scheduleStatus(season))}</p>`
      }
      ${
        prediction.ungradedGameIds.length
          ? `<p class="schedule-status league-schedule-status">${prediction.ungradedGameIds.length} completed game${
              prediction.ungradedGameIds.length === 1 ? " was" : "s were"
            } filled with actual results and excluded from scoring.</p>`
          : ""
      }
      <div class="league-team-grid">
        ${teams.map((team) => leagueTeamCard(prediction, season, team)).join("")}
      </div>
    </section>`;

  app.querySelector(".league-team-grid").addEventListener("click", (event) => {
    const card = event.target.closest("[data-league-team]");
    if (!card) return;
    const team = card.dataset.leagueTeam;
    const series = predictionSeries(prediction, season, team);
    if (!series.length) {
      prediction.activeTeam = team;
      prediction.updatedAt = Date.now();
      saveLeaguePrediction(prediction);
      location.hash = "#season-prediction/league/team";
      return;
    }
    const firstIncomplete = firstIncompleteSeriesIndex(series, prediction.picks);
    prediction.activeTeam = team;
    prediction.seriesIndex = firstIncomplete < series.length ? firstIncomplete : 0;
    prediction.updatedAt = Date.now();
    saveLeaguePrediction(prediction);
    location.hash = "#season-prediction/league/play";
  });
}

function leagueStandingRow(entry, rank) {
  return `<tr>
    <td>${rank}</td>
    <td>
      <button type="button" class="standing-team standing-team-button"
        data-league-result-team="${escapeHtml(entry.team)}">
        ${teamLogo(entry.team, "standing-team-logo")}
        <strong>${escapeHtml(entry.team)}</strong>
      </button>
    </td>
    <td><b>${recordText(entry.records.overall)}</b></td>
    <td>${recordText(entry.records.home)}</td>
    <td>${recordText(entry.records.away)}</td>
  </tr>`;
}

function renderLeaguePredictionResults(status = "") {
  setKeys(null);
  const prediction = currentLeaguePrediction();
  const season = predictionSeason(prediction?.seasonId);
  if (!prediction || !season) {
    location.hash = "#season-prediction/league";
    return;
  }
  const pickedGames = season.games.filter((game) => prediction.picks[game.id]).length;
  if (pickedGames < season.games.length) {
    location.hash = "#season-prediction/league";
    return;
  }
  const standings = predictionTeams(season)
    .map((team) => ({
      team,
      records: predictionRecords({ team, picks: prediction.picks }, season),
    }))
    .sort(
      (a, b) =>
        b.records.overall.wins - a.records.overall.wins ||
        a.records.overall.losses - b.records.overall.losses ||
        a.team.localeCompare(b.team)
    );
  const conferences = [
    ["Eastern Conference", standings.filter((entry) => EASTERN_CONFERENCE.has(entry.team))],
    ["Western Conference", standings.filter((entry) => !EASTERN_CONFERENCE.has(entry.team))],
  ];
  const title = leaguePredictionTitle(prediction);
  const rules = leaguePredictionRules(prediction, season);
  const performance = predictionPerformance(prediction, season.games);
  app.innerHTML = `
    <section class="league-results">
      <span class="results-kicker">${escapeHtml(season.label)} full-league prediction</span>
      ${editableResultTitle(title, prediction.name)}
      <p class="result-rules">${escapeHtml(rules)}</p>
      ${predictionPerformanceMarkup(performance)}
      <div class="league-standings-grid">
        ${conferences
          .map(
            ([name, entries]) => `<section class="conference-standings">
              <h2>${name}</h2>
              <table>
                <colgroup>
                  <col class="standing-rank-column" />
                  <col />
                  <col class="standing-record-column" />
                  <col class="standing-split-column" />
                  <col class="standing-split-column" />
                </colgroup>
                <thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col">Record</th><th scope="col">Home</th><th scope="col">Away</th></tr></thead>
                <tbody>${entries.map((entry, index) => leagueStandingRow(entry, index + 1)).join("")}</tbody>
              </table>
            </section>`
          )
          .join("")}
      </div>
      <div class="results-actions">
        <button type="button" class="btn primary" data-export-league-image>Save image</button>
        <button type="button" class="btn" data-export-league-data>Export data</button>
        <label class="btn ghost file-btn">Import
          <input type="file" accept=".json,application/json" data-import-league />
        </label>
        <a class="btn ghost" href="./">All features</a>
      </div>
      <p class="backup-status league-results-status" role="status">${escapeHtml(status)}</p>
    </section>`;

  bindResultNameEditor((name) => {
    prediction.name = name;
    prediction.updatedAt = Date.now();
    saveLeaguePrediction(prediction);
    renderLeaguePredictionResults(status);
  });
  app.querySelector(".league-standings-grid").addEventListener("click", (event) => {
    const teamButton = event.target.closest("[data-league-result-team]");
    if (!teamButton) return;
    prediction.activeTeam = teamButton.dataset.leagueResultTeam;
    prediction.updatedAt = Date.now();
    saveLeaguePrediction(prediction);
    location.hash = "#season-prediction/league/team";
  });
  app.querySelector("[data-export-league-image]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Creating…";
    try {
      const blob = await renderLeaguePredictionImage({
        title,
        subtitle: rules,
        conferences,
        footer: "zateutsch.github.io/nba-ranker",
      });
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      await saveImageBlob(blob, `${slug || "nba-predicted-standings"}.png`, title);
      button.textContent = label;
    } catch {
      button.textContent = "Couldn't save image";
    } finally {
      button.disabled = false;
    }
  });
  app.querySelector("[data-export-league-data]").addEventListener("click", () => {
    exportLeaguePrediction(prediction);
  });
  app.querySelector("[data-import-league]").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const message = await importPredictionData(file);
      const imported = loadLeaguePrediction();
      const importedSeason = predictionSeason(imported?.seasonId);
      if (
        !imported ||
        !importedSeason ||
        importedSeason.games.some((game) => !imported.picks[game.id])
      ) {
        location.hash = "#season-prediction/league";
      } else {
        renderLeaguePredictionResults(message);
      }
    } catch (error) {
      renderLeaguePredictionResults(error.message);
    }
  });
}

function compactPredictionScheduleMarkup(schedule) {
  const columnSize = Math.ceil(schedule.length / 4);
  const columns = Array.from(
    { length: 4 },
    (_, index) => schedule.slice(index * columnSize, (index + 1) * columnSize)
  );
  const filters = [
    ["all", "All", schedule.length],
    ["correct", "Correct", schedule.filter((game) => game.assessment === "correct").length],
    ["wrong", "Wrong", schedule.filter((game) => game.assessment === "wrong").length],
    ["excluded", "Excluded", schedule.filter((game) => game.assessment === "excluded").length],
    ["pending", "Pending", schedule.filter((game) => game.assessment === "pending").length],
  ];
  return `
    <section class="results-schedule">
      <h2>Prediction results</h2>
      <p>Compare each prediction with the result. Games completed before the prediction are excluded from scoring.</p>
      <div class="result-filters" role="group" aria-label="Filter prediction results">
        ${filters
          .map(
            ([value, label, count]) => `<button type="button" class="result-filter"
              data-result-filter="${value}" aria-pressed="${value === "all"}">
              ${label} <span>${count}</span>
            </button>`
          )
          .join("")}
      </div>
      <div class="results-schedule-columns">
        ${columns
          .filter((column) => column.length)
          .map(
            (column) => `<table>
              <caption>Games ${column[0].number}-${column.at(-1).number}</caption>
              <colgroup>
                <col class="results-game-number" />
                <col />
                <col class="results-game-result" />
              </colgroup>
              <thead><tr><th scope="col">#</th><th scope="col">Game</th><th scope="col">W/L</th></tr></thead>
              <tbody>
                ${column
                  .map(
                    (game) => `<tr data-result-status="${game.assessment}">
                      <td>${game.number}</td>
                      <td>
                        <span class="results-game-date">${escapeHtml(game.date)}</span>
                        <span class="results-game-opponent"><b>${game.site}</b> ${escapeHtml(game.opponent)} <small>(${game.seriesRecord})</small></span>
                        <span class="results-game-assessment is-${game.assessment}">${game.assessmentLabel}</span>
                        <span class="results-game-actual">${escapeHtml(game.actualResult)}</span>
                      </td>
                      <td><strong class="results-game-outcome is-${
                        game.result === "W" ? "win" : game.result === "L" ? "loss" : "pending"
                      }">${game.result}</strong></td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>`
          )
          .join("")}
      </div>
      <p class="result-filter-empty" hidden>No games match this filter.</p>
    </section>`;
}

function bindPredictionResultFilters(root = app) {
  const schedule = root.querySelector(".results-schedule");
  if (!schedule) return;
  const buttons = [...schedule.querySelectorAll("[data-result-filter]")];
  const rows = [...schedule.querySelectorAll("[data-result-status]")];
  const tables = [...schedule.querySelectorAll("table")];
  const empty = schedule.querySelector(".result-filter-empty");
  schedule.querySelector(".result-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-result-filter]");
    if (!button) return;
    const filter = button.dataset.resultFilter;
    buttons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    rows.forEach((row) => {
      row.hidden = filter !== "all" && row.dataset.resultStatus !== filter;
    });
    tables.forEach((table) => {
      table.hidden = !table.querySelector("tbody tr:not([hidden])");
    });
    empty.hidden = rows.some((row) => !row.hidden);
  });
}

function renderLeagueTeamResults() {
  setKeys(null);
  const prediction = loadLeaguePrediction();
  const season = predictionSeason(prediction?.seasonId);
  const team = prediction?.activeTeam;
  if (!prediction || !season || !predictionTeams(season).includes(team)) {
    location.hash = "#season-prediction/league/results";
    return;
  }
  const games = gamesForTeam(season, team);
  const records = predictionRecords({ team, picks: prediction.picks }, season);
  const performance = predictionPerformance(prediction, games);
  const complete = games.every((game) => prediction.picks[game.id]);
  const title = leaguePredictionTitle(prediction);
  const rules = `${season.label} · ${team} · Full-league team results`;
  const predictedSchedule = games.map((game, index) => {
    const home = game.homeTeam === team;
    const opponent = home ? game.awayTeam : game.homeTeam;
    const winner = prediction.picks[game.id];
    const assessment = predictionGameAssessment(prediction, game, team);
    return {
      number: index + 1,
      date: formatScheduleDate(game.dateUtc),
      opponent,
      site: home ? "vs" : "@",
      result: winner ? (winner === team ? "W" : "L") : "—",
      seriesRecord: recordText(records.opponents.get(opponent) ?? { wins: 0, losses: 0 }),
      assessment: assessment.status,
      assessmentLabel: assessment.label,
      actualResult: assessment.actual,
    };
  });
  app.innerHTML = `
    <section class="prediction-results league-team-results">
      <span class="results-kicker">${escapeHtml(season.label)} full-league prediction</span>
      ${editableResultTitle(title, prediction.name)}
      <p class="result-rules">${escapeHtml(rules)}</p>
      <div class="team-banner results-team-banner" style="${teamStyle(teamNickname(team))}">
        ${teamLogo(team, "team-logo")}
        <span class="team-banner-text">
          <span class="team-banner-name">${escapeHtml(team)}</span>
          <span class="team-banner-sub">${escapeHtml(season.label)} predicted schedule</span>
        </span>
      </div>
      <div class="predicted-record">
        <span>Predicted record</span>
        <strong>${recordText(records.overall)}</strong>
      </div>
      <div class="record-grid">
        <div><span>Home</span><strong>${recordText(records.home)}</strong></div>
        <div><span>Away</span><strong>${recordText(records.away)}</strong></div>
        <div><span>Games</span><strong>${games.length}</strong></div>
      </div>
      ${predictionPerformanceMarkup(performance)}
      <div class="results-actions">
        <button type="button" class="btn primary" data-export-league-team-image
          ${complete ? "" : "disabled"}>Save image</button>
        <a class="btn" href="#season-prediction/league/results">All standings</a>
      </div>
      ${compactPredictionScheduleMarkup(predictedSchedule)}
    </section>`;

  bindResultNameEditor((name) => {
    prediction.name = name;
    prediction.updatedAt = Date.now();
    saveLeaguePrediction(prediction);
    renderLeagueTeamResults();
  });
  bindPredictionResultFilters();
  app.querySelector("[data-export-league-team-image]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Creating…";
    try {
      const blob = await renderPredictionImage({
        title,
        subtitle: rules,
        overall: recordText(records.overall),
        schedule: predictedSchedule,
        footer: "zateutsch.github.io/nba-ranker",
      });
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      await saveImageBlob(blob, `${slug || "nba-league-team-prediction"}.png`, title);
      button.textContent = label;
    } catch {
      button.textContent = "Couldn't save image";
    } finally {
      button.disabled = false;
    }
  });
}

function formatGameDate(dateUtc) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(dateUtc));
}

function formatScheduleDate(dateUtc) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(dateUtc));
}

function predictionSchedule(games, prediction, currentSeries = null) {
  const currentGameIds = new Set(currentSeries?.games.map((game) => game.id) ?? []);
  const pickedGames = games.filter((game) => prediction.picks[game.id]).length;
  return `
    <details class="prediction-schedule">
      <summary>
        <span>Full schedule</span>
        <span>${pickedGames} of ${games.length} predicted</span>
      </summary>
      <div class="schedule-list">
        ${games
          .map((game, index) => {
            const home = game.homeTeam === prediction.team;
            const opponent = home ? game.awayTeam : game.homeTeam;
            const winner = prediction.picks[game.id];
            const result = winner ? (winner === prediction.team ? "W" : "L") : "";
            const state = [
              winner ? (result === "W" ? "is-win" : "is-loss") : "",
              currentGameIds.has(game.id) ? "is-current" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `<div class="schedule-row${state ? ` ${state}` : ""}">
              <span class="schedule-number">${index + 1}</span>
              <span class="schedule-date">${escapeHtml(formatScheduleDate(game.dateUtc))}</span>
              <span class="schedule-opponent"><b>${home ? "vs" : "@"}</b> ${escapeHtml(opponent)}</span>
              <span class="schedule-result">${result || (currentGameIds.has(game.id) ? "Now" : "—")}</span>
            </div>`;
          })
          .join("")}
      </div>
    </details>`;
}

function renderPredictionGame() {
  setKeys(null);
  const prediction = loadPrediction();
  const season = predictionSeason(prediction?.seasonId);
  const games = gamesForTeam(season, prediction?.team);
  if (!prediction || !season || !games.length) {
    location.hash = "#season-prediction";
    return;
  }
  if (normalizePredictionProgress(prediction, season)) savePrediction(prediction);
  const series = predictionSeries(prediction, season);
  if (predictionIsComplete(prediction, games)) {
    location.hash = "#season-prediction/results";
    return;
  }

  const currentSeries = series[prediction.index];
  const progress = Math.round((prediction.index / series.length) * 100);
  const opponent = currentSeries.opponent;
  const records = predictionRecords(prediction, season);
  const priorSeason = priorSeasonFor(season);
  const teamOverall = priorSeason ? actualTeamRecord(priorSeason, prediction.team) : null;
  const opponentOverall = priorSeason ? actualTeamRecord(priorSeason, opponent) : null;
  const teamHeadToHead = priorSeason
    ? actualTeamRecord(priorSeason, prediction.team, opponent)
    : null;
  const opponentHeadToHead = priorSeason
    ? actualTeamRecord(priorSeason, opponent, prediction.team)
    : null;
  const draft = Object.fromEntries(
    currentSeries.games.map((game) => {
      const winner = prediction.picks[game.id];
      return [game.id, winner ? (winner === prediction.team ? "W" : "L") : ""];
    })
  );

  app.innerHTML = `
    <section class="prediction-play">
      <div class="prediction-progress">
        <span>Series ${prediction.index + 1} of ${series.length}</span>
        <span>${games.filter((game) => prediction.picks[game.id]).length} of ${games.length} games predicted</span>
      </div>
      <div class="progress-track" aria-hidden="true"><span style="width:${progress}%"></span></div>
      <div class="series-heading">
        <div>
          <span>Record so far</span>
          <strong>${recordText(records.overall)}</strong>
        </div>
        <p>${currentSeries.games.length}-game season series</p>
      </div>
      <h1>${escapeHtml(prediction.team)} vs ${escapeHtml(opponent)}</h1>
      <div class="series-matchup">
        ${[
          [prediction.team, teamOverall, teamHeadToHead],
          [opponent, opponentOverall, opponentHeadToHead],
        ]
          .map(
            ([name, overall, headToHead]) => `<article class="series-team-card"
              style="${teamStyle(teamNickname(name))}">
              ${teamLogo(name, "series-team-logo")}
              <strong>${escapeHtml(name)}</strong>
              ${
                overall
                  ? `<div class="series-records">
                      <span><small>Last season</small><b>${recordText(overall)}</b></span>
                      <span><small>Head-to-head</small><b>${recordText(headToHead)}</b></span>
                    </div>`
                  : ""
              }
            </article>`
          )
          .join("")}
      </div>
      <div class="series-games" aria-label="Predict each game in this series">
        ${currentSeries.games
          .map((game, index) => {
            const home = game.homeTeam === prediction.team;
            const result = draft[game.id];
            return `<article class="series-game" data-series-game="${escapeHtml(game.id)}">
              <div class="series-game-info">
                <span>Game ${index + 1}</span>
                <strong>${escapeHtml(formatGameDate(game.dateUtc))}</strong>
                <small>${home ? "Home" : "Away"} ${home ? "vs" : "at"} ${escapeHtml(opponent)}</small>
              </div>
              <div class="series-result-toggle" aria-label="Game ${index + 1} result">
                ${["W", "L"]
                  .map(
                    (resultOption) => `<button type="button"
                      class="series-result${result === resultOption ? " is-selected" : ""}"
                      data-series-result="${resultOption}"
                      aria-pressed="${result === resultOption}">${resultOption}</button>`
                  )
                  .join("")}
              </div>
            </article>`;
          })
          .join("")}
      </div>
      <div class="prediction-controls">
        <button type="button" class="btn ghost" data-prediction-back ${prediction.index ? "" : "disabled"}>&larr; Previous series</button>
        <button type="button" class="btn primary" data-confirm-series
          ${Object.values(draft).every(Boolean) ? "" : "disabled"}>Confirm series</button>
        <a class="btn ghost" href="#season-prediction">Save &amp; exit</a>
      </div>
      ${predictionSchedule(games, prediction, currentSeries)}
    </section>`;

  const confirmButton = app.querySelector("[data-confirm-series]");
  app.querySelector(".series-games").addEventListener("click", (e) => {
    const choice = e.target.closest("[data-series-result]");
    if (!choice) return;
    const gameElement = choice.closest("[data-series-game]");
    draft[gameElement.dataset.seriesGame] = choice.dataset.seriesResult;
    gameElement.querySelectorAll("[data-series-result]").forEach((button) => {
      const selected = button === choice;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    confirmButton.disabled = !Object.values(draft).every(Boolean);
  });
  confirmButton.addEventListener("click", () => {
    if (!Object.values(draft).every(Boolean)) return;
    currentSeries.games.forEach((game) => {
      prediction.picks[game.id] =
        draft[game.id] === "W" ? prediction.team : currentSeries.opponent;
    });
    prediction.index += 1;
    prediction.updatedAt = Date.now();
    savePrediction(prediction);
    if (predictionIsComplete(prediction, games)) location.hash = "#season-prediction/results";
    else renderPredictionGame();
  });
  app.querySelector("[data-prediction-back]").addEventListener("click", () => {
    if (!prediction.index) return;
    prediction.index -= 1;
    prediction.updatedAt = Date.now();
    savePrediction(prediction);
    renderPredictionGame();
  });
}

function renderLeaguePredictionSeries() {
  setKeys(null);
  const prediction = currentLeaguePrediction();
  const season = predictionSeason(prediction?.seasonId);
  const team = prediction?.activeTeam;
  if (!prediction || !season || !predictionTeams(season).includes(team)) {
    location.hash = "#season-prediction/league";
    return;
  }
  if (leaguePredictionIsComplete(prediction, season)) {
    location.hash = "#season-prediction/league/results";
    return;
  }
  const games = gamesForTeam(season, team);
  const series = predictionSeries(prediction, season, team);
  prediction.seriesIndex = Math.min(Math.max(prediction.seriesIndex, 0), series.length - 1);
  const currentSeries = series[prediction.seriesIndex];
  const opponent = currentSeries.opponent;
  const teamPickedGames = games.filter((game) => prediction.picks[game.id]).length;
  const leaguePickedGames = season.games.filter((game) => prediction.picks[game.id]).length;
  const records = predictionRecords({ team, picks: prediction.picks }, season);
  const priorSeason = priorSeasonFor(season);
  const teamOverall = priorSeason ? actualTeamRecord(priorSeason, team) : null;
  const opponentOverall = priorSeason ? actualTeamRecord(priorSeason, opponent) : null;
  const teamHeadToHead = priorSeason ? actualTeamRecord(priorSeason, team, opponent) : null;
  const opponentHeadToHead = priorSeason ? actualTeamRecord(priorSeason, opponent, team) : null;
  const draft = Object.fromEntries(
    currentSeries.games.map((game) => {
      const winner = prediction.picks[game.id];
      return [game.id, winner ? (winner === team ? "W" : "L") : ""];
    })
  );
  const existingPicks = new Set(
    currentSeries.games.filter((game) => prediction.picks[game.id]).map((game) => game.id)
  );
  const teamProgress = Math.round((teamPickedGames / games.length) * 100);

  app.innerHTML = `
    <section class="prediction-play league-series-play">
      <div class="prediction-progress">
        <span>Entire NBA · ${leaguePickedGames} of ${season.games.length} games</span>
        <span>${escapeHtml(team)} · ${teamPickedGames} of ${games.length}</span>
      </div>
      <div class="progress-track" aria-hidden="true"><span style="width:${teamProgress}%"></span></div>
      <div class="series-heading">
        <div>
          <span>Record in progress</span>
          <strong>${recordText(records.overall)}</strong>
        </div>
        <p>${currentSeries.games.length}-game season series</p>
      </div>
      <h1>${escapeHtml(team)} vs ${escapeHtml(opponent)}</h1>
      <div class="series-matchup">
        ${[
          [team, teamOverall, teamHeadToHead],
          [opponent, opponentOverall, opponentHeadToHead],
        ]
          .map(
            ([name, overall, headToHead]) => `<article class="series-team-card"
              style="${teamStyle(teamNickname(name))}">
              ${teamLogo(name, "series-team-logo")}
              <strong>${escapeHtml(name)}</strong>
              ${
                overall
                  ? `<div class="series-records">
                      <span><small>Last season</small><b>${recordText(overall)}</b></span>
                      <span><small>Head-to-head</small><b>${recordText(headToHead)}</b></span>
                    </div>`
                  : ""
              }
            </article>`
          )
          .join("")}
      </div>
      <div class="series-games" aria-label="Predict each game in this series">
        ${currentSeries.games
          .map((game, index) => {
            const home = game.homeTeam === team;
            const result = draft[game.id];
            return `<article class="series-game${existingPicks.has(game.id) ? " has-shared-pick" : ""}"
              data-series-game="${escapeHtml(game.id)}">
              <div class="series-game-info">
                <span>Game ${index + 1}${existingPicks.has(game.id) ? " · Already predicted" : ""}</span>
                <strong>${escapeHtml(formatGameDate(game.dateUtc))}</strong>
                <small>${home ? "Home" : "Away"} ${home ? "vs" : "at"} ${escapeHtml(opponent)}</small>
              </div>
              <div class="series-result-toggle" aria-label="Game ${index + 1} result">
                ${["W", "L"]
                  .map(
                    (resultOption) => `<button type="button"
                      class="series-result${result === resultOption ? " is-selected" : ""}"
                      data-series-result="${resultOption}"
                      aria-pressed="${result === resultOption}">${resultOption}</button>`
                  )
                  .join("")}
              </div>
            </article>`;
          })
          .join("")}
      </div>
      <div class="prediction-controls">
        <button type="button" class="btn ghost" data-league-series-back
          ${prediction.seriesIndex ? "" : "disabled"}>&larr; Previous series</button>
        <button type="button" class="btn primary" data-confirm-league-series
          ${Object.values(draft).every(Boolean) ? "" : "disabled"}>
          ${existingPicks.size === currentSeries.games.length ? "Update series" : "Confirm series"}
        </button>
        <button type="button" class="btn ghost" data-league-save-exit
          title="Progress will be saved">Back to League</button>
      </div>
      ${predictionSchedule(games, { team, picks: prediction.picks }, currentSeries)}
    </section>`;

  const confirmButton = app.querySelector("[data-confirm-league-series]");
  app.querySelector(".series-games").addEventListener("click", (event) => {
    const choice = event.target.closest("[data-series-result]");
    if (!choice) return;
    const gameElement = choice.closest("[data-series-game]");
    const gameId = gameElement.dataset.seriesGame;
    draft[gameId] = choice.dataset.seriesResult;
    gameElement.querySelectorAll("[data-series-result]").forEach((button) => {
      const selected = button === choice;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    confirmButton.disabled = !Object.values(draft).every(Boolean);
  });
  confirmButton.addEventListener("click", () => {
    if (!Object.values(draft).every(Boolean)) return;
    currentSeries.games.forEach((game) => {
      prediction.picks[game.id] = draft[game.id] === "W" ? team : opponent;
    });
    const nextIncomplete = series.findIndex(
      (matchup, index) =>
        index > prediction.seriesIndex &&
        matchup.games.some((game) => !prediction.picks[game.id])
    );
    const firstIncomplete = firstIncompleteSeriesIndex(series, prediction.picks);
    prediction.updatedAt = Date.now();
    if (leaguePredictionIsComplete(prediction, season)) {
      prediction.activeTeam = null;
      prediction.seriesIndex = 0;
      saveLeaguePrediction(prediction);
      location.hash = "#season-prediction/league/results";
    } else if (nextIncomplete >= 0) {
      prediction.seriesIndex = nextIncomplete;
      saveLeaguePrediction(prediction);
      renderLeaguePredictionSeries();
    } else if (firstIncomplete < series.length) {
      prediction.seriesIndex = firstIncomplete;
      saveLeaguePrediction(prediction);
      renderLeaguePredictionSeries();
    } else {
      prediction.activeTeam = null;
      prediction.seriesIndex = 0;
      saveLeaguePrediction(prediction);
      location.hash = "#season-prediction/league";
    }
  });
  app.querySelector("[data-league-series-back]").addEventListener("click", () => {
    if (!prediction.seriesIndex) return;
    prediction.seriesIndex -= 1;
    prediction.updatedAt = Date.now();
    saveLeaguePrediction(prediction);
    renderLeaguePredictionSeries();
  });
  app.querySelector("[data-league-save-exit]").addEventListener("click", () => {
    prediction.activeTeam = null;
    prediction.updatedAt = Date.now();
    saveLeaguePrediction(prediction);
    location.hash = "#season-prediction/league";
  });
}

function predictionRecords(prediction, season) {
  const games = gamesForTeam(season, prediction.team);
  const records = {
    overall: { wins: 0, losses: 0 },
    home: { wins: 0, losses: 0 },
    away: { wins: 0, losses: 0 },
    opponents: new Map(),
  };

  for (const game of games) {
    const winner = prediction.picks[game.id];
    if (!winner) continue;
    const win = winner === prediction.team;
    const location = game.homeTeam === prediction.team ? "home" : "away";
    const opponent = game.homeTeam === prediction.team ? game.awayTeam : game.homeTeam;
    records.overall[win ? "wins" : "losses"] += 1;
    records[location][win ? "wins" : "losses"] += 1;
    const opponentRecord = records.opponents.get(opponent) ?? { wins: 0, losses: 0 };
    opponentRecord[win ? "wins" : "losses"] += 1;
    records.opponents.set(opponent, opponentRecord);
  }
  return records;
}

function recordText(record) {
  return `${record.wins}-${record.losses}`;
}

function renderPredictionResults() {
  setKeys(null);
  const prediction = loadPrediction();
  const season = predictionSeason(prediction?.seasonId);
  const games = gamesForTeam(season, prediction?.team);
  if (!prediction || !season || !games.length) {
    location.hash = "#season-prediction";
    return;
  }
  if (!predictionIsComplete(prediction, games)) {
    location.hash = "#season-prediction/play";
    return;
  }

  const records = predictionRecords(prediction, season);
  const performance = predictionPerformance(prediction, games);
  const title = teamPredictionTitle(prediction);
  const rules = teamPredictionRules(prediction, season);
  const predictedSchedule = games.map((game, index) => {
    const home = game.homeTeam === prediction.team;
    const opponent = home ? game.awayTeam : game.homeTeam;
    const assessment = predictionGameAssessment(prediction, game, prediction.team);
    return {
      number: index + 1,
      date: formatScheduleDate(game.dateUtc),
      opponent,
      site: home ? "vs" : "@",
      result: prediction.picks[game.id] === prediction.team ? "W" : "L",
      seriesRecord: recordText(records.opponents.get(opponent)),
      assessment: assessment.status,
      assessmentLabel: assessment.label,
      actualResult: assessment.actual,
    };
  });
  app.innerHTML = `
    <section class="prediction-results">
      <span class="results-kicker">${escapeHtml(season.label)} prediction</span>
      ${editableResultTitle(title, prediction.name)}
      <p class="result-rules">${escapeHtml(rules)}</p>
      ${predictionPerformanceMarkup(performance)}
      <div class="predicted-record">
        <span>Predicted record</span>
        <strong>${recordText(records.overall)}</strong>
      </div>
      <div class="record-grid">
        <div><span>Home</span><strong>${recordText(records.home)}</strong></div>
        <div><span>Away</span><strong>${recordText(records.away)}</strong></div>
        <div><span>Games</span><strong>${games.length}</strong></div>
      </div>
      ${
        season.complete
          ? ""
          : `<p class="schedule-status is-partial">This reflects the ${season.knownGamesPerTeam} currently scheduled games. Return after NBA Cup scheduling to predict the final ${season.expectedGamesPerTeam - season.knownGamesPerTeam}.</p>`
      }
      <div class="results-actions">
        <button type="button" class="btn primary" data-export-prediction>Save image</button>
        <button type="button" class="btn" data-export-prediction-data>Export data</button>
        <button type="button" class="btn" data-restart-prediction>Predict again</button>
        <a class="btn ghost" href="./">All features</a>
      </div>
      ${compactPredictionScheduleMarkup(predictedSchedule)}
    </section>`;

  bindResultNameEditor((name) => {
    prediction.name = name;
    prediction.updatedAt = Date.now();
    savePrediction(prediction);
    renderPredictionResults();
  });
  bindPredictionResultFilters();
  app.querySelector("[data-export-prediction]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Creating…";
    try {
      const blob = await renderPredictionImage({
        title,
        subtitle: rules,
        overall: recordText(records.overall),
        schedule: predictedSchedule,
        footer: "zateutsch.github.io/nba-ranker",
      });
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      await saveImageBlob(blob, `${slug || "nba-season-prediction"}.png`, title);
      button.textContent = label;
    } catch {
      button.textContent = "Couldn't save image";
    } finally {
      button.disabled = false;
    }
  });
  app.querySelector("[data-export-prediction-data]").addEventListener("click", () => {
    exportPredictions([prediction], predictionDataFileName(prediction));
  });
  app.querySelector("[data-restart-prediction]").addEventListener("click", () => {
    deletePrediction(prediction);
    location.hash = "#season-prediction/team";
  });
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
    return `<div class="headshot no-photo ${cls}" style="${teamStyle(nick)}" role="img" aria-label="${escapeHtml(p.name)}">
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
  const title = rankingDisplayTitle(session);
  const rules = rankingRules(session);
  const canUndo = Boolean(sessionSet(session)) && session.answers.length > 0;

  const statLine = (p) => {
    const s = p.careerRegularSeason || {};
    return `${fmt(s.pts)} PTS · ${fmt(s.reb)} REB · ${fmt(s.ast)} AST`;
  };

  app.innerHTML = `
    <section class="results">
      ${editableResultTitle(title, session.name)}
      <p class="result-rules">${escapeHtml(rules)}</p>
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

  bindResultNameEditor((name) => {
    session.name = name;
    session.title = name || rankingTitle(session);
    save();
    renderResults(session.ranking);
  });
  app.querySelector("[data-action=image]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      const blob = await renderRankingImage({
        title,
        subtitle: rules,
        ranked,
        footer: "zateutsch.github.io/nba-ranker",
      });
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      await saveImageBlob(blob, `${slug || "nba-ranking"}.png`, title);
      btn.textContent = label;
    } catch {
      btn.textContent = "Couldn't save image";
    } finally {
      btn.disabled = false;
    }
  });
  app.querySelector("[data-action=copy]").addEventListener("click", async (e) => {
    const text = `${title}\n${rules}\n\n${ranked.map((p, i) => `${i + 1}. ${p.name}`).join("\n")}`;
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
function savedHead(r, title, meta, { pinnable = false, editable = false, openLabel }) {
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
        ${
          editable
            ? `<button type="button" class="icon-btn edit" data-edit="${r.id}"
                aria-label="Edit name" title="Edit name">${EDIT_ICON}</button>`
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
    ${savedHead(r, rankingDisplayTitle(r), `${rankingRules(r)} · ${r.answers.length} of up to ${total} picks · ${shortDate(r.updatedAt)}`, { openLabel: "Resume" })}
    <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
  </li>`;
}

function finishedCard(r) {
  const top = r.ranking.map((id) => players.get(id)).filter(Boolean).slice(0, 3);
  return `<li class="saved-card${r.pinned ? " pinned" : ""}">
    ${savedHead(r, rankingDisplayTitle(r), `${rankingRules(r)} · ${r.ranking.length} players · finished ${shortDate(r.finishedAt)}`, { pinnable: true, editable: true, openLabel: "View" })}
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
        <a class="btn primary small" href="#player-ranking">+ New ranking</a>
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
      ${tab === "finished" && list.length ? nameDialog("ranking") : ""}
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
  const renameDialog = app.querySelector('[data-name-dialog="ranking"]');
  let renameTarget = null;
  app.querySelector(".saved-list")?.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    const pin = e.target.closest("[data-pin]");
    const edit = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-delete]");
    if (open) openRanking(byId.get(open.dataset.open));
    else if (pin) {
      togglePinned(pin.dataset.pin);
      renderMyRankings(tab);
      app.querySelector(`[data-pin="${pin.dataset.pin}"]`)?.focus();
    } else if (edit) {
      renameTarget = byId.get(edit.dataset.edit);
      openNameDialog(renameDialog, renameTarget.name ?? "", rankingDisplayTitle(renameTarget));
    } else if (del) {
      const r = byId.get(del.dataset.delete);
      const name = rankingDisplayTitle(r) ?? "this ranking";
      if (!confirm(`Delete “${name}”? This can't be undone.`)) return;
      deleteRanking(r.id);
      renderMyRankings(tab);
    }
  });
  bindNameDialog(renameDialog, (name) => {
    if (!renameTarget) return;
    renameRanking(renameTarget.id, name);
    renderMyRankings(tab);
  });
}

// ---------- Routing ----------

function route() {
  session = null;
  const hash = location.hash;
  if (!hash) renderHome();
  else if (hash === "#player-ranking") renderSetup();
  else if (hash === "#season-prediction") renderPredictionMode();
  else if (hash === "#season-prediction/team") renderPredictionSetup();
  else if (hash === "#season-prediction/play") renderPredictionGame();
  else if (hash === "#season-prediction/results") renderPredictionResults();
  else if (hash === "#season-prediction/league/library") renderLeaguePredictionLibrary();
  else if (hash === "#season-prediction/league") renderLeaguePredictionHub();
  else if (hash === "#season-prediction/league/play") renderLeaguePredictionSeries();
  else if (hash === "#season-prediction/league/results") renderLeaguePredictionResults();
  else if (hash === "#season-prediction/league/team") renderLeagueTeamResults();
  else if (hash === "#my-predictions") renderMyPredictions();
  else if (hash === "#my-predictions/team") renderMyPredictions("", "team");
  else if (hash === "#my-predictions/league") renderMyPredictions("", "league");
  else if (hash === "#my-rankings") renderMyRankings();
  else if (hash === "#my-rankings/in-progress") renderMyRankings("progress");
  else if (hash === "#my-rankings/finished") renderMyRankings("finished");
  else renderHome();
  window.scrollTo(0, 0);
}

// ---------- Boot ----------

async function init() {
  try {
    const [playerResponse, scheduleResponse] = await Promise.all([
      fetch("data/players.json"),
      fetch("data/schedules.json", { cache: "no-store" }).catch(() => null),
    ]);
    if (!playerResponse.ok) throw new Error(playerResponse.statusText);
    const data = await playerResponse.json();
    players = new Map(data.players.map((p) => [p.id, p]));
    addLatestAllStarSet();
    if (scheduleResponse?.ok) {
      try {
        scheduleData = await scheduleResponse.json();
      } catch {
        scheduleData = null;
      }
    }
  } catch (err) {
    app.innerHTML = `<p class="error">Couldn't load player data (${escapeHtml(err.message)}).</p>`;
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}

init();
