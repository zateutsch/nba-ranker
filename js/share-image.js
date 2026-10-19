// Draws shareable PNGs with the Canvas API. NBA.com headshots are omitted
// because their missing CORS headers would taint the canvas.

const W = 1080;
const PAD = 64;
const INNER = W - PAD * 2;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
// Colours come from the theme variables in css/styles.css.
function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    bgTop: v("--bg-top"),
    bg: v("--bg"),
    surface: v("--surface"),
    surface2: v("--surface-2"),
    border: v("--border"),
    text: v("--text"),
    muted: v("--muted"),
    accent: v("--accent"),
    onAccent: v("--on-accent"),
    lime: v("--lime"),
    onLime: v("--on-lime"),
    medals: [v("--gold"), v("--silver"), v("--bronze")],
  };
}

const PODIUM_H = 172;
const FEATURED_H = 88;
const REST_H = 44;
const REST_COLS = 3;
const GAP = 16;

const font = (weight, size) => `${weight} ${size}px ${FONT}`;
const logoUrl = new URL("../img/lockup-light.svg", import.meta.url).href;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Couldn't load image: ${url}`));
    image.src = url;
  });
}

let logoPromise;
const loadLogo = () => (logoPromise ??= loadImage(logoUrl));

function drawBrandHeader(ctx, logo, label) {
  ctx.drawImage(logo, PAD, PAD - 10, 248, 73);
  ctx.fillStyle = themeColors().accent;
  ctx.font = font(800, 21);
  ctx.letterSpacing = "2px";
  ctx.fillText(label, PAD + 280, PAD + 35);
  ctx.letterSpacing = "0px";
  return PAD + 112;
}

function accoladeText(a) {
  const items = [
    [a.championships, "Ring", "Rings"],
    [a.mvp, "MVP", "MVP"],
    [a.finalsMvp, "Finals MVP", "Finals MVP"],
    [a.dpoy, "DPOY", "DPOY"],
    [a.allStar, "All-Star", "All-Star"],
    [a.allNba, "All-NBA", "All-NBA"],
  ];
  return items
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => (n > 1 ? `${n}× ${many}` : one))
    .join("  ·  ");
}

const statLine = (p) => {
  const s = p.careerRegularSeason || {};
  const f = (v) => (v == null ? "–" : Number(v).toFixed(1));
  return `${f(s.pts)} PTS · ${f(s.reb)} REB · ${f(s.ast)} AST`;
};

// Shrink the font down to minSize to fit, then ellipsize.
function fitText(ctx, text, maxWidth, weight, size, minSize = size) {
  let s = size;
  ctx.font = font(weight, s);
  while (s > minSize && ctx.measureText(text).width > maxWidth) {
    s -= 1;
    ctx.font = font(weight, s);
  }
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`;
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

export async function renderRankingImage({ title, subtitle = "", ranked, footer }) {
  const C = themeColors();
  const logo = await loadLogo();
  const podium = ranked.slice(0, 3);
  const featured = ranked.slice(3, 10);
  const rest = ranked.slice(10);
  const restRows = Math.ceil(rest.length / REST_COLS);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  ctx.font = font(800, 60);
  const titleLines = wrapLines(ctx, title, INNER, 2);
  ctx.font = font(600, 32);
  const subLines = subtitle ? wrapLines(ctx, subtitle, INNER, 4) : [];
  const headerH = 112 + titleLines.length * 70 + subLines.length * 42 + (subLines.length ? 12 : 0) + 40;
  const podiumH = podium.length * (PODIUM_H + GAP);
  const featuredH = featured.length ? 16 + featured.length * (FEATURED_H + 10) : 0;
  const restH = rest.length ? 48 + restRows * REST_H : 0;
  const footerH = 96;
  const H = Math.max(W, PAD + headerH + podiumH + featuredH + restH + footerH);

  canvas.width = W;
  canvas.height = H;

  // Background
  const bg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, Math.max(W, H) * 0.9);
  bg.addColorStop(0, C.bgTop);
  bg.addColorStop(0.6, C.bg);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, 0, W, 10);

  ctx.textBaseline = "alphabetic";
  let y = drawBrandHeader(ctx, logo, "PLAYER RANKING");
  ctx.fillStyle = C.text;
  ctx.font = font(800, 60);
  for (const line of titleLines) {
    ctx.fillText(line, PAD, y + 56);
    y += 70;
  }
  if (subLines.length) {
    y += 12;
    ctx.fillStyle = C.muted;
    ctx.font = font(600, 32);
    for (const line of subLines) {
      ctx.fillText(line, PAD, y + 30);
      y += 42;
    }
  }
  y += 40;

  // Top 3
  podium.forEach((p, i) => {
    const color = C.medals[i];
    roundRect(ctx, PAD, y, INNER, PODIUM_H, 22, C.surface);
    roundRect(ctx, PAD, y, 12, PODIUM_H, 6, color);
    ctx.fillStyle = color;
    ctx.font = font(900, 112);
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), PAD + 100, y + PODIUM_H / 2 + 40);
    ctx.textAlign = "left";

    const x = PAD + 190;
    const maxW = INNER - 190 - 32;
    ctx.fillStyle = C.text;
    ctx.fillText(fitText(ctx, p.name, maxW, 800, 52, 36), x, y + 66);
    ctx.fillStyle = C.muted;
    ctx.fillText(fitText(ctx, statLine(p), maxW, 500, 28), x, y + 108);
    const acc = accoladeText(p.accolades);
    if (acc) {
      ctx.fillStyle = color;
      ctx.fillText(fitText(ctx, acc, maxW, 700, 26, 20), x, y + 146);
    }
    y += PODIUM_H + GAP;
  });

  // 4–10
  if (featured.length) {
    y += 16;
    featured.forEach((p, i) => {
      roundRect(ctx, PAD, y, INNER, FEATURED_H, 16, C.surface2);
      ctx.fillStyle = C.accent;
      ctx.font = font(800, 40);
      ctx.textAlign = "center";
      ctx.fillText(String(i + 4), PAD + 56, y + FEATURED_H / 2 + 14);
      ctx.textAlign = "right";
      ctx.fillStyle = C.muted;
      ctx.font = font(500, 24);
      const stats = statLine(p);
      const statsW = ctx.measureText(stats).width;
      ctx.fillText(stats, PAD + INNER - 28, y + FEATURED_H / 2 + 9);
      ctx.textAlign = "left";
      ctx.fillStyle = C.text;
      const nameW = INNER - 112 - statsW - 56;
      ctx.fillText(fitText(ctx, p.name, nameW, 700, 36, 26), PAD + 112, y + FEATURED_H / 2 + 13);
      y += FEATURED_H + 10;
    });
  }

  // 11+
  if (rest.length) {
    y += 24;
    ctx.fillStyle = C.border;
    ctx.fillRect(PAD, y, INNER, 2);
    y += 24;
    const colW = INNER / REST_COLS;
    rest.forEach((p, i) => {
      // Fill columns top-to-bottom so the order reads naturally.
      const col = Math.floor(i / restRows);
      const row = i % restRows;
      const x = PAD + col * colW;
      const ry = y + row * REST_H + 30;
      ctx.fillStyle = C.muted;
      ctx.font = font(700, 22);
      const rank = String(i + 11);
      ctx.fillText(rank, x, ry);
      ctx.fillStyle = C.text;
      ctx.fillText(fitText(ctx, p.name, colW - 68, 500, 24, 18), x + 54, ry);
    });
    y += restRows * REST_H;
  }

  // Footer
  ctx.fillStyle = C.muted;
  ctx.font = font(500, 24);
  ctx.textAlign = "center";
  ctx.fillText(footer, W / 2, H - PAD + 8);
  ctx.textAlign = "left";

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't create image"))), "image/png")
  );
}

export async function renderPredictionImage({ title, subtitle, overall, schedule, footer }) {
  const C = themeColors();
  const logo = await loadLogo();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const columnCount = 4;
  const colGap = 12;
  const colW = (INNER - colGap * (columnCount - 1)) / columnCount;
  const rowH = 58;
  const rowsPerColumn = Math.ceil(schedule.length / columnCount);
  ctx.font = font(800, 58);
  const titleLines = wrapLines(ctx, title, INNER, 2);
  ctx.font = font(600, 27);
  const subtitleLines = subtitle ? wrapLines(ctx, subtitle, INNER, 2) : [];
  const headerH =
    112 + titleLines.length * 66 + (subtitleLines.length ? subtitleLines.length * 36 + 18 : 0) + 18 + 220 + 64;
  const scheduleH = rowsPerColumn * rowH;
  const footerH = 110;
  const H = PAD + headerH + scheduleH + footerH;

  canvas.width = W;
  canvas.height = H;

  const bg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, Math.max(W, H) * 0.7);
  bg.addColorStop(0, C.bgTop);
  bg.addColorStop(0.55, C.bg);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, 0, W, 10);

  ctx.textBaseline = "alphabetic";
  let y = drawBrandHeader(ctx, logo, "SEASON PREDICTION");

  ctx.fillStyle = C.text;
  ctx.font = font(800, 58);
  for (const line of titleLines) {
    ctx.fillText(line, PAD, y + 54);
    y += 66;
  }
  if (subtitleLines.length) {
    y += 8;
    ctx.fillStyle = C.muted;
    ctx.font = font(600, 27);
    for (const line of subtitleLines) {
      ctx.fillText(line, PAD, y + 27);
      y += 36;
    }
    y += 10;
  }
  y += 18;

  roundRect(ctx, PAD, y, INNER, 172, 22, C.surface);
  ctx.fillStyle = C.muted;
  ctx.font = font(700, 24);
  ctx.textAlign = "center";
  ctx.fillText("PREDICTED RECORD", W / 2, y + 40);
  ctx.fillStyle = C.text;
  ctx.font = font(900, 92);
  ctx.fillText(overall, W / 2, y + 134);
  ctx.textAlign = "left";
  y += 220;

  ctx.fillStyle = C.text;
  ctx.font = font(800, 34);
  ctx.fillText("FULL SCHEDULE", PAD, y + 34);
  y += 64;

  schedule.forEach((game, index) => {
    const col = Math.floor(index / rowsPerColumn);
    const row = index % rowsPerColumn;
    const x = PAD + col * (colW + colGap);
    const rowY = y + row * rowH;
    roundRect(ctx, x, rowY, colW, rowH - 6, 10, row % 2 ? C.surface2 : C.surface);

    ctx.fillStyle = C.muted;
    ctx.font = font(700, 14);
    ctx.fillText(String(game.number).padStart(2, "0"), x + 9, rowY + 20);
    ctx.font = font(600, 14);
    ctx.fillText(game.date, x + 35, rowY + 20);

    const resultW = 32;
    const resultX = x + colW - resultW - 7;
    roundRect(
      ctx,
      resultX,
      rowY + 8,
      resultW,
      resultW,
      8,
      game.result === "W" ? C.lime : C.accent
    );
    ctx.fillStyle = game.result === "W" ? C.onLime : C.onAccent;
    ctx.font = font(900, 17);
    ctx.textAlign = "center";
    ctx.fillText(game.result, resultX + resultW / 2, rowY + 30);
    ctx.textAlign = "left";

    const opponentX = x + 9;
    const opponentW = resultX - opponentX - 10;
    ctx.fillStyle = C.text;
    ctx.font = font(700, 14);
    ctx.fillText(
      fitText(ctx, `${game.site} ${game.opponent} (${game.seriesRecord})`, opponentW, 700, 14, 10),
      opponentX,
      rowY + 43
    );
  });

  ctx.fillStyle = C.muted;
  ctx.font = font(500, 22);
  ctx.textAlign = "center";
  ctx.fillText(footer, W / 2, H - PAD + 8);
  ctx.textAlign = "left";

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't create image"))), "image/png")
  );
}

export async function renderLeaguePredictionImage({ title, subtitle, conferences, footer }) {
  const C = themeColors();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const logo = await loadLogo();
  const colGap = 24;
  const colW = (INNER - colGap) / 2;
  const rowH = 58;
  ctx.font = font(900, 62);
  const titleLines = wrapLines(ctx, title, INNER, 2);
  ctx.font = font(600, 28);
  const subtitleLines = wrapLines(ctx, subtitle, INNER, 2);
  const headerH = 112 + titleLines.length * 70 + subtitleLines.length * 40 + 76;
  const tableH = 76 + 15 * rowH;
  const H = PAD + headerH + tableH + 100;

  canvas.width = W;
  canvas.height = H;

  const bg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.75);
  bg.addColorStop(0, C.bgTop);
  bg.addColorStop(0.6, C.bg);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, 0, W, 10);

  ctx.textBaseline = "alphabetic";
  let y = drawBrandHeader(ctx, logo, "FULL-LEAGUE PREDICTION");
  ctx.fillStyle = C.text;
  ctx.font = font(900, 62);
  for (const line of titleLines) {
    ctx.fillText(line, PAD, y + 54);
    y += 70;
  }
  ctx.fillStyle = C.muted;
  ctx.font = font(600, 28);
  for (const line of subtitleLines) {
    ctx.fillText(line, PAD, y + 28);
    y += 40;
  }

  const tableY = PAD + headerH;
  conferences.forEach(([name, entries], conferenceIndex) => {
    const x = PAD + conferenceIndex * (colW + colGap);
    ctx.fillStyle = C.text;
    ctx.font = font(800, 30);
    ctx.fillText(name, x, tableY - 24);

    entries.forEach((entry, index) => {
      const y = tableY + index * rowH;
      roundRect(ctx, x, y, colW, rowH - 7, 10, index % 2 ? C.surface2 : C.surface);
      ctx.fillStyle = C.muted;
      ctx.font = font(700, 18);
      ctx.fillText(String(index + 1), x + 12, y + 33);
      ctx.fillStyle = C.text;
      ctx.font = font(700, 19);
      ctx.fillText(fitText(ctx, entry.team, colW - 150, 700, 19, 14), x + 42, y + 33);
      ctx.textAlign = "right";
      ctx.font = font(800, 20);
      ctx.fillText(`${entry.records.overall.wins}-${entry.records.overall.losses}`, x + colW - 14, y + 33);
      ctx.textAlign = "left";
    });
  });

  ctx.fillStyle = C.muted;
  ctx.font = font(500, 22);
  ctx.textAlign = "center";
  ctx.fillText(footer, W / 2, H - PAD + 8);
  ctx.textAlign = "left";

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't create image"))), "image/png")
  );
}
