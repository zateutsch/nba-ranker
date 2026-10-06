// Interactive ranking driven by recorded answers. The algorithm is re-run from
// scratch against the answer log each time, so saving, resuming and undoing are
// just operations on that log.

class NeedInput {
  constructor(a, b) {
    this.a = a;
    this.b = b;
  }
}

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Returns { done: true, ranking } (best first) or { done: false, pair: [a, b] }.
export function runSort(ids, mode, k, answers) {
  const memo = new Map(answers.map(({ a, b, winner }) => [pairKey(a, b), winner]));
  const better = (a, b) => {
    const winner = memo.get(pairKey(a, b));
    if (winner === undefined) throw new NeedInput(a, b);
    return winner === a;
  };
  try {
    const ranking = mode === "top" && k < ids.length ? topK(ids, k, better) : insertionSort(ids, better);
    return { done: true, ranking };
  } catch (e) {
    if (e instanceof NeedInput) return { done: false, pair: [e.a, e.b] };
    throw e;
  }
}

function insertionSort(ids, better) {
  const sorted = [];
  for (const id of ids) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (better(id, sorted[mid])) hi = mid;
      else lo = mid + 1;
    }
    sorted.splice(lo, 0, id);
  }
  return sorted;
}

// Knockout tournament over fixed slots. After a winner is taken its slot
// becomes a bye, so finding the next best only replays matches on its path.
function topK(ids, k, better) {
  const taken = new Set();
  const best = (lo, hi) => {
    if (hi - lo === 1) return taken.has(ids[lo]) ? null : ids[lo];
    const mid = (lo + hi) >> 1;
    const left = best(lo, mid);
    const right = best(mid, hi);
    if (left === null) return right;
    if (right === null) return left;
    return better(left, right) ? left : right;
  };
  const result = [];
  for (let i = 0; i < k; i++) {
    const winner = best(0, ids.length);
    result.push(winner);
    taken.add(winner);
  }
  return result;
}

// Upper bound on the number of picks needed.
export function maxPicks(n, mode, k) {
  const log2 = (x) => Math.ceil(Math.log2(x));
  if (mode === "top" && k < n) return n - 1 + (k - 1) * log2(n);
  let total = 0;
  for (let i = 1; i < n; i++) total += log2(i + 1);
  return total;
}

// Deterministic PRNG so a saved seed reproduces the same shuffle.
export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(items, seed) {
  const rand = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
