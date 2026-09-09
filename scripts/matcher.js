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
