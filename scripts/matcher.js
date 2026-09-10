const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Correspondances explicites pour les divergences de nommage
// (ex. renommages Pathfinder vs libellés savaged.us)
const ALIASES = {
  // 'armor:leather-cap': 'light-cap-head',
};

const IGNORED_NAMES = new Set(['(unarmored)', '(unskilled)', 'unarmed']);

let INDEX = null;

async function buildIndex() {
  INDEX = { bySlug: new Map(), byTokens: new Map() };

  for (const pack of game.packs) {
    if (pack.documentName !== 'Item') continue;
    const idx = await pack.getIndex({ fields: ['name', 'type', 'system.swid'] });
    for (const entry of idx.values()) {
      if (!entry?.type) continue;
      const rec = { uuid: entry.uuid, name: entry.name, type: entry.type };
      const keys = [entry.system?.swid, entry.name].filter(Boolean);
      for (const key of keys) {
        const k = `${entry.type}:${slugify(key)}`;
        if (!INDEX.bySlug.has(k)) INDEX.bySlug.set(k, rec);
      }
      const toks = slugify(entry.name).split('-').filter(Boolean).sort().join('-');
      const tk = `${entry.type}:${toks}`;
      if (!INDEX.byTokens.has(tk)) INDEX.byTokens.set(tk, rec);
    }
  }
  return INDEX;
}

function findRecord(type, name) {
  if (!INDEX) throw new Error('Index non construit — appelez buildIndex() d\'abord');
  const clean = String(name).replace(/\s*\((.*)\)\s*$/, '').trim();
  const slug = slugify(clean);

  const aliasKey = `${type}:${slug}`;
  if (ALIASES[aliasKey]) {
    const aliased = INDEX.bySlug.get(`${type}:${slugify(ALIASES[aliasKey])}`);
    if (aliased) return aliased;
  }

  let rec = INDEX.bySlug.get(aliasKey);
  if (rec) return rec;

  const tokenKey = `${type}:${slug.split('-').filter(Boolean).sort().join('-')}`;
  rec = INDEX.byTokens.get(tokenKey);
  if (rec) return rec;

  return null;
}

export { slugify, buildIndex, findRecord, IGNORED_NAMES };

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Coefficient de Dice entre deux chaînes (0 à 1) */
export function diceSimilarity(a, b) {
  const A = bigrams(slugify(a)), B = bigrams(slugify(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * Retourne les N meilleures correspondances pour un nom donné,
 * triées par score décroissant. Score = 0..1.
 */
export function suggestMatches(type, name, limit = 5, minScore = 0.3) {
  if (!INDEX) throw new Error('Index non construit');
  const clean = String(name).replace(/\s*\((.*)\)\s*$/, '').trim();
  const reqTokens = new Set(slugify(clean).split('-').filter(Boolean));

  const scored = [];
  const seen = new Set();
  for (const rec of INDEX.bySlug.values()) {
    if (rec.type !== type || seen.has(rec.uuid)) continue;
    seen.add(rec.uuid);

    let score = diceSimilarity(clean, rec.name);

    // Recouvrement de tokens (pondéré fortement : les inversions comptent beaucoup)
    const recTokens = new Set(slugify(rec.name).split('-').filter(Boolean));
    let shared = 0;
    for (const t of reqTokens) if (recTokens.has(t)) shared++;
    if (reqTokens.size) {
      const overlap = shared / Math.max(reqTokens.size, recTokens.size);
      score = Math.max(score, score * 0.5 + overlap * 0.5);
    }

    if (score >= minScore) scored.push({ ...rec, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
