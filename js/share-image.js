// Draws a ranking as a shareable PNG with the Canvas API. Text only: NBA.com
// headshots don't send CORS headers, so drawing them would taint the canvas.

const W = 1080;
const PAD = 64;
const INNER = W - PAD * 2;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const C = {
  bgTop: "#1a2130",
  bg: "#0d1117",
  surface: "#161b22",
  surface2: "#1f2630",
  border: "#2d3540",
  text: "#e8edf3",
  muted: "#8b96a5",
  accent: "#f58426",
  medals: ["#f5c542", "#c9d1d9", "#d08a4f"],
};

const PODIUM_H = 172;
const FEATURED_H = 88;
const REST_H = 44;
const REST_COLS = 3;
const GAP = 16;

const font = (weight, size) => `${weight} ${size}px ${FONT}`;

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

export function renderRankingImage({ title, subtitle = "", ranked, footer }) {
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
  const headerH = 40 + 24 + titleLines.length * 70 + subLines.length * 42 + (subLines.length ? 12 : 0) + 40;
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
  let y = PAD;

  // Header
  ctx.fillStyle = C.accent;
  ctx.font = font(800, 28);
  ctx.letterSpacing = "4px";
  ctx.fillText("NBA RANKER", PAD, y + 28);
  ctx.letterSpacing = "0px";
  y += 40 + 24;
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
