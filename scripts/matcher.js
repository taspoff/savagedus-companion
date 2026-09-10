const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Correspondances explicites pour les divergences de nommage
// Clé : "<type>:<slug-savaged>" -> valeur : "<swid-ou-nom-cible>"
const ALIASES = {};

// Noms normalisés à ignorer complètement (Unarmored, Unskilled...)
const IGNORED_NAMES = new Set(['unarmored', 'unskilled', 'unarmed']);

let INDEX = null;

/**
 * Priorité d'un pack : PLUS LE NOMBRE EST PETIT, PLUS LE PACK EST PRIVILÉGIÉ.
 * Ordre par défaut (adaptable) :
 *   0 : modules de règles achetés / premium (SWPF, Flash Gordon, etc.)
 *   1 : packs inconnus (contenus maison, traductions...)
 *   2 : SRD gratuits (swade-core-rules, archives-of-nethys...)
 * Un paramètre module "priorityPacks" permet de forcer l'ordre pour
 * des packs spécifiques, sous forme de liste d'ids séparés par des virgules,
 * du plus prioritaire au moins prioritaire.
 */
const DEFAULT_PRIORITY_ORDER = [
  // packs achetés d'abord (le plus spécifique/payant en tête)
  'swpf-apg-2',
  'swpf-apg',
  'swpf-core-rules',
  // SRD gratuits ensuite
  'swade-core-rules',
  'swade-deluxe',
];

function getPackPriority(pack, priorityOrder) {
  const idx = priorityOrder.indexOf(pack.metadata.id);
  return idx === -1 ? 1 : idx; // inconnu -> priorité intermédiaire
}

async function buildIndex() {
  // Ordre de priorité éventuellement personnalisé via les settings du module
  const custom = game.settings?.get('savagedus-companion', 'priorityPacks');
  const priorityOrder = (custom?.trim() ? custom : DEFAULT_PRIORITY_ORDER.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Packs d'items triés : prioritaires en premier
  const itemPacks = game.packs.filter((p) => p.documentName === 'Item');
  itemPacks.sort((a, b) => getPackPriority(a, priorityOrder) - getPackPriority(b, priorityOrder));

  INDEX = { bySlug: new Map(), byTokens: new Map() };

  // Première passe : constitution des entrées (first-win, packs prioritaires en tête)
  for (const pack of itemPacks) {
    const idx = await pack.getIndex({ fields: ['name', 'type', 'system.swid'] });
    for (const entry of idx.values()) {
      if (!entry?.type || !entry?.name) continue;
      const rec = {
        uuid: entry.uuid,
        name: entry.name,
        type: entry.type,
        pack: pack.metadata.id,
        priority: getPackPriority(pack, priorityOrder),
      };
      for (const key of [entry.system?.swid, entry.name]) {
        if (!key) continue;
        const k = `${entry.type}:${slugify(key)}`;
        if (!INDEX.bySlug.has(k)) INDEX.bySlug.set(k, rec);
      }
      const toks = slugify(entry.name).split('-').filter(Boolean).sort().join('-');
      const tk = `${entry.type}:${toks}`;
      if (!INDEX.byTokens.has(tk)) INDEX.byTokens.set(tk, rec);
    }
  }

  // Seconde passe (recentrage) : ne garder en bySlug QUE les entrées du meilleur
  // pack disponible quand plusieurs items de types différents ont été fusionnés —
  // (aucune action nécessaire ici : first-win + tri initial suffit, mais on purge
  // les doublons de bySlug dont l'entrée est d'une priorité plus basse qu'une
  // autre entrée équivalente découverte après tri — déjà garanti par le tri.)
  return INDEX;
}

function findRecord(type, name) {
  if (!INDEX) throw new Error("Index non construit — appelez buildIndex() d'abord");
  const clean = String(name).replace(/\s*\(.*\)\s*$/, '').trim();
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
  return rec ?? null;
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Coefficient de Dice entre deux chaînes (0 à 1) */
function diceSimilarity(a, b) {
  const A = bigrams(slugify(a)), B = bigrams(slugify(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * Retourne les N meilleures correspondances candidates pour un nom donné,
 * triées par score décroissant puis par priorité de pack (payant avant SRD).
 */
function suggestMatches(type, name, limit = 5, minScore = 0.3) {
  if (!INDEX) throw new Error("Index non construit — appelez buildIndex() d'abord");
  const clean = String(name).replace(/\s*\(.*\)\s*$/, '').trim();
  const reqTokens = new Set(slugify(clean).split('-').filter(Boolean));

  const scored = [];
  const seen = new Set();
  for (const rec of INDEX.bySlug.values()) {
    if (rec.type !== type || seen.has(rec.uuid)) continue;
    seen.add(rec.uuid);

    let score = diceSimilarity(clean, rec.name);

    const recTokens = new Set(slugify(rec.name).split('-').filter(Boolean));
    let shared = 0;
    for (const t of reqTokens) if (recTokens.has(t)) shared++;
    if (reqTokens.size) {
      const overlap = shared / Math.max(reqTokens.size, recTokens.size);
      score = Math.max(score, score * 0.5 + overlap * 0.5);
    }

    if (score >= minScore) scored.push({ ...rec, score });
  }

  // Tri : score d'abord, priorité de pack en départage
  scored.sort((a, b) => b.score - a.score || a.priority - b.priority);
  return scored.slice(0, limit);
}

export { slugify, buildIndex, findRecord, suggestMatches, IGNORED_NAMES, DEFAULT_PRIORITY_ORDER };
