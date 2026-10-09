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
const setById = (id, filter) => (id === "custom" ? customSet(filter) : SETS.find((s) => s.id === id));
const sessionSet = (s) => setById(s.setId, s.filter);
const idsForSet = (set) => [...players.values()].filter(set.filter).map((p) => p.id);

function rankingTitle(s) {
  const set = sessionSet(s);
  const top = s.mode === "top" ? `Top ${TOP_K}` : "";
  if (set.custom) return `My ${top || "ranking"}: ${set.name}`;
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

function save() {
  if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(STORAGE_KEY);
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && sessionSet(saved) && Array.isArray(saved.answers)) return saved;
  } catch {
    /* ignore corrupt state */
  }
  return null;
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
  const saved = loadSaved();
  const savedSet = saved && sessionSet(saved);
  let filter = loadCustomFilter();
  app.innerHTML = `
    <section class="setup">
      <h1>Rank the legends.</h1>
      <p class="lede">Pick a group, then choose between two players at a time until your ranking is settled.</p>
      ${
        saved
          ? `<div class="resume">
              <span>You have a ranking in progress: <strong>${escapeHtml(savedSet.name)}</strong>
              (${saved.mode === "top" ? `Top ${TOP_K}` : "full"}, ${saved.answers.length} picks made)</span>
              <span class="resume-actions">
                <button type="button" class="btn" data-action="resume">Resume</button>
                <button type="button" class="btn ghost" data-action="discard">Discard</button>
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
            <label class="set-card custom-card">
              <input type="radio" name="set" value="custom" />
              <span class="set-name">Custom</span>
              <span class="set-desc">Build your own group from awards, eras and more</span>
              <span class="set-count" data-custom-count></span>
            </label>
          </div>
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
  const builder = form.querySelector(".custom-builder");
  const startBtn = form.querySelector("[type=submit]");

  const currentSet = () => (form.set.value === "custom" ? customSet(filter) : setById(form.set.value));

  const update = () => {
    const isCustom = form.set.value === "custom";
    builder.hidden = !isCustom;
    const customIds = idsForSet(customSet(filter));
    form.querySelector("[data-custom-count]").textContent = `${customIds.length} players`;
    if (isCustom) renderCustomPreview(builder, customIds);
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

  form.addEventListener("change", (e) => {
    if (builder.contains(e.target)) onFilterChange();
    else update();
  });
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
    rebuild();
  });
  rebuild();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const isCustom = form.set.value === "custom";
    session = {
      setId: form.set.value,
      ...(isCustom ? { filter: structuredClone(filter) } : {}),
      mode: form.mode.value,
      seed: Math.floor(Math.random() * 2 ** 31),
      answers: [],
    };
    save();
    renderCompare();
  });

  app.querySelector("[data-action=resume]")?.addEventListener("click", () => {
    session = saved;
    renderCompare();
  });
  app.querySelector("[data-action=discard]")?.addEventListener("click", () => {
    session = null;
    save();
    renderSetup();
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

function renderCustomPreview(el, ids) {
  const preview = el.querySelector(".custom-preview");
  if (!preview) return;
  if (!ids.length) {
    preview.innerHTML = `<strong>No players match.</strong> Try loosening a rule.`;
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

function headshot(p, cls = "") {
  const initials = p.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
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
    renderResults(result.ranking);
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
        <button class="btn ghost" data-action="quit">Start over</button>
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
  app.querySelector("[data-action=quit]").addEventListener("click", () => {
    if (done && !confirm("Discard this ranking and start over?")) return;
    session = null;
    save();
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
  const title = rankingTitle(session);

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
        <button class="btn" data-action="undo">↶ Undo last pick</button>
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
        title: set.custom ? heading : title,
        subtitle: set.custom ? set.name : "",
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
    save();
    renderCompare();
  });
  app.querySelector("[data-action=new]").addEventListener("click", () => {
    session = null;
    save();
    renderSetup();
  });
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
  renderSetup();
}

init();
