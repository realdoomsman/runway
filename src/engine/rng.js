// Deterministic PRNG (mulberry32). The colony boots identically from the same
// seed, so the world feels persistent across reloads; live ticks use a
// clock-seeded stream so each session's future unfolds differently.

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeRng(seed) {
  const next = mulberry32(seed)
  const rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    // Skewed toward low values; exponent > 1 pushes mass down. Used for
    // competence so most agents are mediocre and a few are exceptional.
    skew: (min, max, exp = 2) => min + Math.pow(next(), exp) * (max - min),
  }
  return rng
}
