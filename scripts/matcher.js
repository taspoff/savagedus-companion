// Indexation de TOUS les packs d'items du monde, indexés par swid ET par nom slufigié
const slugify = (s) => s.toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// Alias pour les divergences de nommage (à enrichir au fil des imports)
const ALIASES = {
  // clefs : type:slug-savaged -> swid cible
  'armor:leather-cap': 'light-cap-head',
  'armor:leather-jacket': 'light-tunic-or-jacket-torso-arms',
  'armor:leather-leggings': 'light-leggings-legs',
};

let INDEX = null;

export async function buildIndex() {
  INDEX = { bySlug: new Map(), byTokens: new Map() };
  for (const pack of game.packs) {
    if (pack.documentName !== 'Item') continue;
    // ne scanner que les packs "règles" (filtrable en settings)
    const idx = await pack.getIndex({ fields: ['name', 'type', 'system.swid'] });
    for (const entry of idx.values()) {
      const rec = { uuid: entry.uuid, name: entry.name, type: entry.type };
      for (const key of [entry.system?.swid, slugify(entry.name)]) {
        if (key) {
          const k = `${entry.type}:${slugify(key)}`;
          if (!INDEX.bySlug.has(k)) INDEX.bySlug.set(k, rec);
        }
      }
      // index par tokens triés (gère "Axe, Great" vs "Great Axe")
      const toks = slugify(entry.name).split('-').sort().join('-');
      INDEX.byTokens.set(`${entry.type}:${toks}`, rec);
    }
  }
}

export async function match(type, name, { report } = {}) {
  let slug = slugify(name.replace(/\s*\([^)]*\)\s*$/, '')); // retire suffixe parenthèse
  // 1) alias explicites
  slug = ALIASES[`${type}:${slug}`]?.split('-').length ? ALIASES[`${type}:${slug}`] : slug;
  // 2) correspondance swid/nom exacte
  let rec = INDEX.bySlug.get(`${type}:${slug}`);
  // 3) tokens triés
  if (!rec) rec = INDEX.byTokens.get(`${type}:${slug.split('-').sort().join('-')}`);
  if (!rec && report) report.push(game.i18n.format('SAVAGEDUS.warn.unmatched', { name }));
  return rec ? fromUuid(rec.uuid) : null;
}
