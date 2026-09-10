/**
 * savagedus-companion — scripts/matcher.js
 *
 * Moteur de correspondance : construit un index des compendiums installés
 * et résout les noms issus des exports savaged.us vers des entrées
 * compendium, avec priorisation des packs payants (SWPF) sur le SRD gratuit.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

/** Score minimal pour qu'une suggestion fuzzy soit proposée. */
export const MIN_SUGGESTION_SCORE = 0.3;

/** Score au-delà duquel la meilleure suggestion est pré-cochée. */
export const PRESELECT_THRESHOLD = 0.75;

/** Nombre maximum de suggestions affichées dans le dialogue d'arbitrage. */
export const MAX_SUGGESTIONS = 5;

/**
 * Ordre de priorité des packs (plus petit = prioritaire).
 * Les APG avant le core rules SWPF, le SRD gratuit en fin de liste.
 */
export const DEFAULT_PRIORITY_ORDER = [
  'swpf-apg-2',
  'swpf-apg',
  'swpf-core-rules',
  'swade-core-rules',
  'swade-deluxe',
];

/**
 * Priorité des packs inconnus (non listés ci-dessus ni dans le setting
 * `priorityPacks`) : intermédiaire, devant le core SWPF et le SRD.
 */
const UNKNOWN_PACK_PRIORITY = 1;

/**
 * Alias explicites : `${type}:${slug-savaged}` -> slug(s) compendium.
 * Chaque cible est essayée avant de retomber sur le matching fuzzy.
 * À vérifier/étendre avec les swids réels de vos compendiums.
 */
export const ALIASES = {
  'armor:leather-cap': ['leather-cap', 'leather-armor'],
  'armor:leather-jacket': ['leather-jacket', 'leather-armor'],
  'armor:leather-leggings': ['leather-leggings', 'leather-armor'],
  'weapon:sword-short': ['short-sword'],
  'weapon:dagger-knife': ['dagger', 'knife'],
};

/** Entrées savaged.us à ignorer totalement (gérées nativement par SWADE). */
export const IGNORED_NAMES = new Set(['unarmored', 'unskilled', 'unarmed']);

/** Familles de types acceptées pour un type demandé (fallback tolérant). */
const TYPE_GROUPS = {
  gear: ['gear', 'equipment', 'consumable'],
  weapon: ['weapon'],
  armor: ['armor'],
  shield: ['shield'],
};

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function deaccent(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** "Arcane Background (Miracles)" -> "arcane-background-miracles" */
export function slugify(text) {
  return deaccent(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Supprime les parenthèses : "Phobia (minor, claustrophobie)" -> "Phobia" */
export function stripParentheses(text) {
  return String(text ?? '').replace(/\([^)]*\)/g, ' ').trim();
}

function tokensOf(text) {
  return deaccent(text).split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

/* ------------------------------------------------------------------ */
/* Scores                                                              */
/* ------------------------------------------------------------------ */

function bigramsOf(str) {
  const out = [];
  for (let i = 0; i < str.length - 1; i++) out.push(str.slice(i, i + 2));
  return out;
}

/** Coefficient de Dice sur bigrammes, borné [0..1]. */
export function diceCoefficient(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const freqA = new Map();
  const freqB = new Map();
  for (const g of bigramsOf(a)) freqA.set(g, (freqA.get(g) ?? 0) + 1);
  for (const g of bigramsOf(b)) freqB.set(g, (freqB.get(g) ?? 0) + 1);
  let hits = 0;
  for (const [g, n] of freqA) {
    const m = freqB.get(g);
    if (m) hits += Math.min(n, m);
  }
  const total = bigramsOf(a).length + bigramsOf(b).length;
  return total ? (2 * hits) / total : 0;
}

/** Recouvrement de tokens (Jaccard), borné [0..1]. */
function tokenOverlap(setA, setB) {
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const union = setA.size + setB.size - shared;
  return union ? shared / union : 0;
}

/* ------------------------------------------------------------------ */
/* Priorité des packs                                                  */
/* ------------------------------------------------------------------ */

/**
 * Priorité d'un pack : setting `priorityPacks` (ids séparés par des
 * virgules, ordre = priorité) > DEFAULT_PRIORITY_ORDER > intermédiaire.
 * Compare l'id complet ET le namespace (avant le point), car les ids
 * réels sont de la forme `swpf-core-rules.core-items`.
 */
export function getPriority(index, packId) {
  const full = String(packId ?? '').toLowerCase();
  const ns = full.split('.')[0];
  for (const id of [full, ns]) {
    if (index.userPriority.has(id)) return index.userPriority.get(id);
    const known = DEFAULT_PRIORITY_ORDER.indexOf(id);
    if (known >= 0) return known;
  }
  return UNKNOWN_PACK_PRIORITY;
}

function typeAccepts(requested, actual) {
  if (!requested || !actual) return true;
  if (requested === actual) return true;
  const group = TYPE_GROUPS[requested] ?? [];
  return group.includes(actual);
}

/* ------------------------------------------------------------------ */
/* Construction de l'index                                             */
/* ------------------------------------------------------------------ */

let cachedIndex = null;

export function invalidateIndex() {
  cachedIndex = null;
}

/**
 * Construit (et met en cache) l'index des compendiums d'items :
 * chaque entrée est enregistrée sous son slug de nom ET son `system.swid`,
 * ce qui rend la recherche indépendante des variations de nommage.
 *
 * @returns {Promise<object>} index { bySlug, byTokens, userPriority }
 */
export async function buildIndex(force = false) {
  if (cachedIndex && !force) return cachedIndex;

  const index = {
    bySlug: new Map(),     // slug -> entrées triées par priorité
    byTokens: new Map(),   // token -> Set<entrée>
    userPriority: new Map(),
  };

  // Priorités personnalisées définies dans les settings du monde.
  try {
    const raw = String(game.settings.get('savagedus-companion', 'priorityPacks') ?? '');
    raw.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .forEach((id, i) => index.userPriority.set(id, i));
  } catch (err) {
    console.warn('savagedus-companion | setting priorityPacks illisible:', err);
  }

  const packs = [...game.packs.values()].filter((p) => p.documentName === 'Item');

  for (const pack of packs) {
    const packId = pack.metadata.id ?? pack.collection;
    const packLabel = pack.metadata.label ?? packId;

    // L'index du pack, en demandant le swid quand le pack l'expose.
    let docs;
    try {
      docs = await pack.getIndex({ fields: ['system.swid'] });
    } catch (err) {
      try {
        docs = await pack.getIndex();
      } catch (err2) {
        console.warn(`savagedus-companion | index indisponible pour ${packId}`);
        continue;
      }
    }

    const priority = getPriority(index, packId);

    for (const doc of docs) {
      const nameSlug = slugify(doc.name);
      const swid = doc.system?.swid ? slugify(doc.system.swid) : '';
      const tokenSet = new Set([...tokensOf(doc.name), ...tokensOf(swid)]);
      const entry = {
        uuid: doc.uuid,
        name: doc.name,
        type: doc.type ?? '',
        swid,
        slug: nameSlug,
        tokens: tokenSet,
        pack: packId,
        packLabel,
        priority,
      };

      // Enregistrement sous le slug de nom ET le swid (dedupliqués).
      for (const key of new Set([nameSlug, swid].filter(Boolean))) {
        if (!index.bySlug.has(key)) index.bySlug.set(key, []);
        index.bySlug.get(key).push(entry);
      }

      // Référencement par tokens pour le fuzzy.
      for (const t of tokenSet) {
        if (!index.byTokens.has(t)) index.byTokens.set(t, new Set());
        index.byTokens.get(t).add(entry);
      }
    }
  }

  // Tri « premier arrivé, premier servi » sur les packs prioritaires.
  for (const list of index.bySlug.values()) {
    list.sort((a, b) => a.priority - b.priority);
  }

  cachedIndex = index;
  return index;
}

/* ------------------------------------------------------------------ */
/* Alias                                                               */
/* ------------------------------------------------------------------ */

/** Cibles d'alias pour `${type}:${slug}`, ou []. */
export function aliasTargets(type, slug) {
  const raw = ALIASES[`${type}:${slug}`] ?? ALIASES[`*:${slug}`];
  return raw ? [].concat(raw).map(slugify).filter(Boolean) : [];
}

/* ------------------------------------------------------------------ */
/* Candidats déterministes                                             */
/* ------------------------------------------------------------------ */

/**
 * Rassemble les candidats dans l'ordre de la cascade :
 * alias -> nom complet -> nom écorché (parenthèses retirées).
 * Chaque liste de slug est déjà triée par priorité de pack.
 */
function gatherCandidates(index, key) {
  const nameSlug = slugify(key.name);
  const stripped = slugify(stripParentheses(key.name));
  const out = [];
  const seen = new Set();

  const pushList = (slug) => {
    if (!slug) return;
    for (const e of index.bySlug.get(slug) ?? []) {
      if (typeAccepts(key.type, e.type) && !seen.has(e.uuid)) {
        seen.add(e.uuid);
        out.push(e);
      }
    }
  };

  for (const target of aliasTargets(key.type, nameSlug)) pushList(target);
  pushList(nameSlug);
  if (stripped && stripped !== nameSlug) pushList(stripped);
  return out;
}

/**
 * Résolution déterministe : premier candidat de la cascade, ou null.
 * @param {object} index résultat de buildIndex()
 * @param {{ type: string, name: string }} key
 */
export function findRecord(index, key) {
  const candidates = gatherCandidates(index, key);
  return candidates[0] ?? null;
}

/**
 * Doublons inter-packs : entrées partageant le même slug de nom/swid.
 * Retourne [] si aucune ambiguïté. Utile pour l'affichage du
 * récapitulatif (« résolu depuis swpf-apg, existe aussi dans SRD »).
 */
export function getDuplicates(index, name) {
  const slug = slugify(name);
  const list = (index.bySlug.get(slug) ?? []).filter(
    (e) => e.pack && e.uuid,
  );
  return list.length > 1
    ? list.map((e) => ({
        name: e.name,
        uuid: e.uuid,
        pack: e.pack,
        packLabel: e.packLabel,
      }))
    : [];
}

/* ------------------------------------------------------------------ */
/* Suggestions fuzzy                                                   */
/* ------------------------------------------------------------------ */

/**
 * Suggestions scorées (Dice + recouvrement de tokens), triées par score
 * décroissant puis priorité de pack. La meilleure est pré-cochée si son
 * score atteint PRESELECT_THRESHOLD.
 *
 * @param {object} index résultat de buildIndex()
 * @param {{ type: string, name: string }} key
 * @returns {Array<{uuid,name,type,pack,packLabel,score,preselect}>}
 */
export function suggestMatches(index, key) {
  const nameSlug = slugify(key.name);
  const stripped = slugify(stripParentheses(key.name));
  const queryTokens = new Set([...tokensOf(key.name), ...tokensOf(stripped)]);

  // Pool : correspondances par slug, par token, et par alias.
  const pool = new Map();
  const add = (e) => {
    if (e && typeAccepts(key.type, e.type)) pool.set(e.uuid, e);
  };
  for (const slug of [nameSlug, stripped]) {
    for (const e of index.bySlug.get(slug) ?? []) add(e);
  }
  for (const t of queryTokens) {
    for (const e of index.byTokens.get(t) ?? []) add(e);
  }
  for (const target of aliasTargets(key.type, nameSlug)) {
    for (const t of tokensOf(target)) {
      for (const e of index.byTokens.get(t) ?? []) add(e);
    }
  }

  const scored = [];
  for (const e of pool.values()) {
    const entrySlugs = new Set([e.slug, e.swid].filter(Boolean));
    let bestDice = 0;
    for (const q of [nameSlug, stripped]) {
      if (!q) continue;
      for (const s of entrySlugs) {
        bestDice = Math.max(bestDice, diceCoefficient(q, s));
      }
    }
    const score = Math.max(bestDice, tokenOverlap(queryTokens, e.tokens));
    if (score >= MIN_SUGGESTION_SCORE) scored.push({ entry: e, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.priority - b.entry.priority);

  return scored.slice(0, MAX_SUGGESTIONS).map(({ entry, score }, i) => ({
    uuid: entry.uuid,
    name: entry.name,
    type: entry.type,
    pack: entry.pack,
    packLabel: entry.packLabel,
    score: Number(score.toFixed(3)),
    preselect: i === 0 && score >= PRESELECT_THRESHOLD,
  }));
}
