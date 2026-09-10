import { slugify, findRecord, IGNORED_NAMES } from './matcher.js';

const MODULE_ID = 'savagedus-companion';

const ATTR_MAP = {
  agility: 'agility',
  smarts: 'smarts',
  spirit: 'spirit',
  strength: 'strength',
  vigor: 'vigor',
};

function validateInput(data) {
  if (!data || typeof data !== 'object') throw new Error('Fichier JSON invalide');
  for (const f of ['name', 'attributes']) {
    if (data[f] === undefined || data[f] === null) {
      throw new Error(`Champ "${f}" manquant dans l'export savaged.us`);
    }
  }
}

/**
 * Extrait à plat tous les couples (type, nom) demandés par l'export,
 * pour permettre la pré-résolution interactive avant l'import.
 */
function collectRequests(data) {
  const reqs = [];
  const add = (type, name) => {
    if (!name) return;
    const key = `${type}:${slugify(String(name).replace(/\s*\(.*\)\s*$/, ''))}`;
    if (!reqs.some((r) => r.key === key)) reqs.push({ type, name, key });
  };
  if (data.race) add('ancestry', data.race);
  for (const sk of Array.isArray(data.skills) ? data.skills : []) {
    if (!IGNORED_NAMES.has(slugify(sk.name)) && (sk.dieValue ?? 4) >= 4) add('skill', sk.name);
  }
  for (const h of Array.isArray(data.hindrances) ? data.hindrances : []) {
    add('hindrance', extractHindranceInfo(h.name).base);
  }
  for (const e of Array.isArray(data.edges) ? data.edges : []) {
    add('edge', typeof e === 'string' ? e : e.name);
  }
  for (const p of Array.isArray(data.powers) ? data.powers : []) add('power', p.name);
  for (const w of Array.isArray(data.weapons) ? data.weapons : []) add('weapon', w.name);
  for (const a of Array.isArray(data.armor) ? data.armor : []) {
    if (!IGNORED_NAMES.has(slugify(a.name))) add('armor', a.name);
  }
  for (const g of Array.isArray(data.gear) ? data.gear : []) add('gear', g.name);
  return reqs;
}

/**
 * Résout un élément : choix manuel (dialogue) > compendium (index) > item brut.
 * Retourne { source, matched }. Les échecs sont tracés dans report.
 */
async function resolveItem(type, name, report, manual = {}) {
  const key = `${type}:${slugify(String(name).replace(/\s*\(.*\)\s*$/, ''))}`;

  // 1) Choix manuel de l'utilisateur
  if (manual[key]) {
    try {
      const doc = await fromUuid(manual[key]);
      if (doc) return { source: doc.toObject(), matched: true };
    } catch (err) {
      console.warn(`${MODULE_ID} | UUID manuel invalide ${manual[key]}`, err);
    }
  }

  // 2) Résolution automatique
  const record = findRecord(type, name);
  if (record) {
    try {
      const doc = await fromUuid(record.uuid);
      if (doc) return { source: doc.toObject(), matched: true };
    } catch (err) {
      console.warn(`${MODULE_ID} | Impossible de charger ${record.uuid}`, err);
    }
  }

  report.push(`${type}: ${name}`);
  return { source: null, matched: false };
}

function toDamageFormula(str) {
  if (!str) return '';
  return String(str).replace(/str\s*\+/i, '@str+').replace(/^str$/i, '@str');
}

function extractHindranceInfo(rawName) {
  // "Phobia (minor, claustrophobie)" -> base "Phobia", détail "claustrophobie"
  const m = String(rawName).match(/^(.*?)\s*\(\s*[^,]*?,\s*(.+?)\s*\)$/);
  if (m && m[1] && m[2]) return { base: m[1].trim(), detail: m[2].trim() };
  return { base: String(rawName).replace(/\s*\(.*\)\s*$/, '').trim(), detail: '' };
}

async function importCharacter(data, report = [], manual = {}) {
  validateInput(data);

  // Acteur NU — le schéma system complet est initialisé par SWADE
  const actor = await Actor.implementation.create({
    name: data.name,
    type: 'character',
  });
  if (!actor) throw new Error(`Impossible de créer l'acteur "${data.name}"`);

  // 1) Patchs ciblés sur des chemins complets (diff-safe, schéma préservé)
  const upd = {
    'system.details.currency': data.wealth ?? 0,
    'system.details.biography.value': `<p>${String(data.background ?? '').replaceAll('\n', '<br/>')}</p>`,
    'system.bennies.value': data.bennies ?? 3,
    'system.advances.rank': data.rankName ?? 'Novice',
    'system.pace.ground': data.paceTotal ?? 6,
  };
  if (typeof data.woundsMax === 'number') upd['system.wounds.max'] = data.woundsMax;
  if (typeof data.fatigueMax === 'number') upd['system.fatigue.max'] = data.fatigueMax;

  for (const a of Array.isArray(data.attributes) ? data.attributes : []) {
    const key = ATTR_MAP[String(a.name).toLowerCase()];
    if (!key) continue;
    upd[`system.attributes.${key}.die.sides`] = a.dieValue ?? 4;
    upd[`system.attributes.${key}.die.modifier`] = a.mod ?? 0;
  }
  await actor.update(upd);

  // 2) Construction des items
  const items = [];

  if (data.race) {
    const { source } = await resolveItem('ancestry', data.race, report, manual);
    items.push(source ?? { name: data.race, type: 'ancestry', system: {} });
  }

  for (const sk of Array.isArray(data.skills) ? data.skills : []) {
    if (IGNORED_NAMES.has(slugify(sk.name))) continue;
    if ((sk.dieValue ?? 4) < 4) continue;
    const { source } = await resolveItem('skill', sk.name, report, manual);
    const d = source ?? { name: sk.name, type: 'skill', system: {} };
    d.system ??= {};
    d.system.die = { ...(d.system.die ?? {}), sides: sk.dieValue, modifier: sk.mod ?? 0 };
    if (sk.attribute && ATTR_MAP[String(sk.attribute).toLowerCase()]) {
      d.system.attribute = ATTR_MAP[String(sk.attribute).toLowerCase()];
    }
    items.push(d);
  }

  for (const h of Array.isArray(data.hindrances) ? data.hindrances : []) {
    const { base, detail } = extractHindranceInfo(h.name);
    const { source } = await resolveItem('hindrance', base, report, manual);
    const d = source ?? { name: base, type: 'hindrance', system: {} };
    d.system ??= {};
    d.name = detail ? `${base} (${detail})` : base;
    d.system.major = Boolean(h.major);
    d.system.severity = h.major ? 'major' : 'minor';
    items.push(d);
  }

  for (const e of Array.isArray(data.edges) ? data.edges : []) {
    const name = typeof e === 'string' ? e : e.name;
    if (!name) continue;
    const { source } = await resolveItem('edge', name, report, manual);
    items.push(source ?? { name, type: 'edge', system: {} });
  }

  for (const p of Array.isArray(data.powers) ? data.powers : []) {
    if (!p?.name) continue;
    const { source } = await resolveItem('power', p.name, report, manual);
    items.push(source ?? { name: p.name, type: 'power', system: {} });
  }

  for (const w of Array.isArray(data.weapons) ? data.weapons : []) {
    if (!w?.name) continue;
    const profile = w.profiles?.[w.activeProfile ?? 0] ?? w.profiles?.[0] ?? {};
    const { source } = await resolveItem('weapon', w.name, report, manual);
    const d = source ?? { name: w.name, type: 'weapon', system: {} };
    d.system ??= {};
    Object.assign(d.system, {
      quantity: w.quantity ?? 1,
      weight: w.weight ?? 0,
      price: w.cost ?? 0,
      damage: toDamageFormula(profile.damage),
      range: profile.range && profile.range !== 'Melee' ? profile.range : '',
      ap: profile.ap ?? 0,
      rof: Number(profile.rof) || 0,
      minStr: w.minStr ?? '',
      equipStatus: w.equipped ? 3 : 1,
      notes: profile.notes ?? '',
    });
    items.push(d);
  }

  for (const a of Array.isArray(data.armor) ? data.armor : []) {
    if (!a?.name || IGNORED_NAMES.has(slugify(a.name))) continue;
    const { source } = await resolveItem('armor', a.name, report, manual);
    const d = source ?? { name: a.name, type: 'armor', system: {} };
    d.system ??= {};
    Object.assign(d.system, {
      armor: a.armor ?? 0,
      quantity: a.quantity ?? 1,
      weight: a.weight ?? 0,
      price: a.cost ?? 0,
      minStr: a.minStr ?? '',
      equipStatus: a.equipped ? 3 : 1,
    });
    d.system.locations = {
      ...(d.system.locations ?? {}),
      head: Boolean(a.coversHead),
      torso: Boolean(a.coversTorso),
      legs: Boolean(a.coversLegs),
      arms: Boolean(a.coversArms),
    };
    items.push(d);
  }

  for (const g of Array.isArray(data.gear) ? data.gear : []) {
    if (!g?.name) continue;
    const { source } = await resolveItem('gear', g.name, report, manual);
    const d = source ?? { name: g.name, type: 'gear', system: {} };
    d.system ??= {};
    Object.assign(d.system, {
      quantity: g.quantity ?? 1,
      weight: g.weight ?? 0,
      price: g.cost ?? 0,
      notes: g.notes ?? '',
    });
    items.push(d);
  }

  if (items.length) await actor.createEmbeddedDocuments('Item', items);

  console.info(
    `${MODULE_ID} | Acteur "${data.name}" importé : ${items.length} items, ${report.length} non-correspondances.`
  );
  return actor;
}

export { importCharacter, collectRequests };
