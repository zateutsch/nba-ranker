import { runSort, maxPicks, shuffle, pairKey } from "./sorter.js";

const TOP_K = 10;
const STORAGE_KEY = "nba-ranker:session";

const SETS = [
  {
    id: "active-all-stars",
    name: "Active NBA All-Stars",
    description: "Current players with at least one All-Star selection",
    filter: (p) => p.active,
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

const app = document.getElementById("app");
let players = new Map();
let session = null; // { setId, mode, seed, answers: [{ a, b, winner }] }
let keyHandler = null;

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const setById = (id) => SETS.find((s) => s.id === id);
const idsForSet = (set) => [...players.values()].filter(set.filter).map((p) => p.id);

function save() {
  if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(STORAGE_KEY);
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && setById(saved.setId) && Array.isArray(saved.answers)) return saved;
  } catch {
    /* ignore corrupt state */
  }
  return null;
}

function sessionIds(s) {
  return shuffle(idsForSet(setById(s.setId)), s.seed);
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
  const savedSet = saved && setById(saved.setId);
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
                <button class="btn" data-action="resume">Resume</button>
                <button class="btn ghost" data-action="discard">Discard</button>
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
          </div>
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
  const updatePicks = () => {
    const set = setById(form.set.value);
    const n = idsForSet(set).length;
    for (const el of form.querySelectorAll("[data-picks]")) {
      el.textContent = `Up to ${maxPicks(n, el.dataset.picks, TOP_K)} picks`;
    }
  };
  form.addEventListener("change", updatePicks);
  updatePicks();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    session = {
      setId: form.set.value,
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

  const set = setById(session.setId);
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
  const set = setById(session.setId);
  const ranked = ranking.map((id) => players.get(id));
  const podium = ranked.slice(0, 3);
  const featured = ranked.slice(3, 10);
  const rest = ranked.slice(10);
  const title = `My ${session.mode === "top" ? `Top ${TOP_K} ` : ""}${set.name}`;

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
        <button class="btn primary" data-action="copy">Copy ranking</button>
        <button class="btn" data-action="undo">↶ Undo last pick</button>
        <button class="btn ghost" data-action="new">Rank again</button>
      </div>
    </section>`;

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
  } catch (err) {
    app.innerHTML = `<p class="error">Couldn't load player data (${escapeHtml(err.message)}).</p>`;
    return;
  }
  renderSetup();
}

init();
