/**
 * savagedus-companion — scripts/importer.js
 *
 * Import d'un personnage exporté depuis savaged.us vers un acteur SWADE.
 * Stratégie : acteur créé « nu » puis patché par chemins complets,
 * items résolus depuis les compendiums avec arbitrage interactif.
 */
'use strict';

import {
  buildIndex,
  findRecord,
  suggestMatches,
  getDuplicates,
  slugify,
  stripParentheses,
  IGNORED_NAMES,
} from './matcher.js';

/* ------------------------------------------------------------------ */
/* Petits utilitaires                                                  */
/* ------------------------------------------------------------------ */

/** "d6" -> 6 ; renvoie 0 si non parsable. */
function dieSides(value) {
  const m = /^d(\d+)/i.exec(String(value ?? '').trim());
  return m ? Number(m[1]) : 0;
}

/** "1d4", "2d8" renvoyés tels quels ; "d10" -> "1d10". */
function normalizeDieString(str) {
  const s = String(str ?? '').trim();
  return /^\d*d\d+/.test(s) && !/^\d/.test(s) ? `1${s}` : s;
}

/**
 * Formule de dégâts savaged.us -> formule SWADE :
 * "Str+d10" -> "@str+1d10", "2d8" -> "2d8".
 */
export function toDamageFormula(damage) {
  let s = String(damage ?? '').trim();
  if (!s) return '';
  s = s.replace(/\bstr\b/gi, '@str');
  s = s.split('+').map(normalizeDieString).join('+');
  return s;
}

/**
 * "Phobia (minor, claustrophobie)" -> { base: 'Phobia', major: false, detail: 'claustrophobie' }
 * Retourne null si le format ne colle pas.
 */
export function extractHindranceInfo(name) {
  const m = /^(.+?)\s*\((major|minor)(?:,\s*(.+))?\)\s*$/i.exec(String(name ?? '').trim());
  if (!m) return null;
  return {
    base: m[1].trim(),
    major: m[2].toLowerCase() === 'major',
    detail: (m[3] ?? '').trim(),
  };
}

/** Noms d'armes dupliqués en armes-fantômes par savaged.us pour les pouvoirs. */
function collectPowerWeaponNames(data) {
  const out = new Set();
  for (const ab of Array.isArray(data.abs) ? data.abs : []) {
    for (const p of Array.isArray(ab.powers) ? ab.powers : []) {
      if (p?.name) out.add(p.name);
      if (p?.customName) out.add(p.customName);
    }
  }
  return out;
}

/** Aplatit récursivement gear[].contains.{gear,weapons,armor,shields}. */
export function flattenGear(list, out = [], parent = null) {
  for (const g of Array.isArray(list) ? list : []) {
    if (!g?.name || IGNORED_NAMES.has(slugify(g.name))) continue;
    const entry = { kind: 'gear', name: g.name, payload: g, parent };
    out.push(entry);
    const c = g.contains ?? {};
    flattenGear(c.gear ?? [], out, g.name);
    for (const w of Array.isArray(c.weapons) ? c.weapons : []) {
      if (w?.name) out.push({ kind: 'weapon', name: w.name, payload: w, parent: g.name });
    }
    for (const a of Array.isArray(c.armor) ? c.armor : []) {
      if (a?.name && !IGNORED_NAMES.has(slugify(a.name))) {
        out.push({ kind: 'armor', name: a.name, payload: a, parent: g.name });
      }
    }
    for (const s of Array.isArray(c.shields) ? c.shields : []) {
      if (s?.name) out.push({ kind: 'shield', name: s.name, payload: s, parent: g.name });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Scan : constitution du plan d'import                                */
/* ------------------------------------------------------------------ */

/**
 * Analyse l'export et retourne la liste des entrées à importer :
 * [{ kind, name (clé de résolution), payload }] — `payload` étant la
 * donnée brute savaged.us dont chaque builder tirera les détails.
 */
export function collectRequests(data) {
  const powerWeapons = collectPowerWeaponNames(data);
  const plans = [];

  // Ancestry (la compétence raciale/grants sont gérés par l'item lui-même)
  if (data.race && !IGNORED_NAMES.has(slugify(data.race))) {
    plans.push({ kind: 'ancestry', name: data.race, payload: null });
  }

  // Atouts
  for (const e of Array.isArray(data.edges) ? data.edges : []) {
    const clean = stripParentheses(e.name);
    if (!clean) continue;
    plans.push({ kind: 'edge', name: clean, payload: e });
  }

  // Handicaps (le format "Nom (major, détail)") est écorché à la clé
  for (const h of Array.isArray(data.hindrances) ? data.hindrances : []) {
    const info = extractHindranceInfo(h.name);
    const base = info ? info.base : stripParentheses(h.name);
    if (!base) continue;
    plans.push({ kind: 'hindrance', name: base, payload: h, hindranceInfo: info });
  }

  // Pouvoirs : hébergés dans abs[].powers[], matchés sur originalName
  for (const ab of Array.isArray(data.abs) ? data.abs : []) {
    for (const p of Array.isArray(ab.powers) ? ab.powers : []) {
      const bookName = p?.originalName || p?.name;
      if (!bookName) continue;
      plans.push({ kind: 'power', name: stripParentheses(bookName), payload: p });
    }
  }

  // Capacités spéciales hors raciales (les raciales sont granted par l'ancestry)
  for (const a of Array.isArray(data.abilities) ? data.abilities : []) {
    if (!a?.name) continue; // entrée de synthèse sans nom : ignorée
    if (a.from === 'Racial') continue;
    plans.push({ kind: 'ability', name: a.name, payload: a });
  }

  // Armures (hors "(Unarmored)")
  for (const ar of Array.isArray(data.armor) ? data.armor : []) {
    if (!ar?.name || IGNORED_NAMES.has(slugify(ar.name))) continue;
    plans.push({ kind: 'armor', name: stripParentheses(ar.name), payload: ar });
  }

  // Boucliers
  for (const s of Array.isArray(data.shields) ? data.shields : []) {
    if (!s?.name) continue;
    plans.push({ kind: 'shield', name: stripParentheses(s.name), payload: s });
  }

  // Armes : on saute Unarmed et les armes-fantômes de pouvoirs
  for (const w of Array.isArray(data.weapons) ? data.weapons : []) {
    if (!w?.name || IGNORED_NAMES.has(slugify(w.name))) continue;
    const isPowerWeapon = powerWeapons.has(w.name)
      || String(w.notes ?? '').startsWith('Power')
      || (Array.isArray(w.profiles) && w.profiles.some((pr) => pr?.skillName === 'Arcane Skill'));
    if (isPowerWeapon) continue;
    plans.push({ kind: 'weapon', name: stripParentheses(w.name), payload: w });
  }

  // Équipement (aplatissement récursif des conteneurs)
  flattenGear(data.gear ?? []);

  return { plans, gearPlans: flattenGear(data.gear ?? []) };
}

/* ------------------------------------------------------------------ */
/* Arbitrage interactif des non-correspondances                        */
/* ------------------------------------------------------------------ */

const RAW_CHOICE = '__RAW__';

function planKey(kind, name) {
  return `${kind}:${slugify(name)}`;
}

/**
 * Affiche le dialogue d'arbitrage pour les entrées sans correspondance
 * déterministe. Retourne une map `${kind}:${slug}` -> uuid ou RAW_CHOICE.
 * Utilise DialogV2 (Foundry v13) instancié puis rendu (pas de .wait()).
 */
async function promptArbitration(index, pending) {
  const manual = {};

  const renderRow = (plan, suggestions) => {
    const uid = planKey(plan.kind, plan.name);
    const optionsHtml = [
      `<option value="${RAW_CHOICE}">— Créer un item brut « ${plan.name} » —</option>`,
      ...suggestions.map((s) => (
        `<option value="${s.uuid}"${s.preselect ? ' selected' : ''}>`
        + `${s.name} (${Math.round(s.score * 100)} %) — ${s.packLabel}`
        + '</option>'
      )),
    ].join('');
    return (
      `<div class="form-group">
        <label style="display:flex;align-items:center;gap:6px;">
          <strong>${plan.name}</strong>
          <em style="color:grey;">(${plan.kind})</em>
        </label>
        <select data-plan="${uid}" style="width:100%;">${optionsHtml}</select>
      </div>`
    );
  };

  // Déduplication des plans identiques (même clé) pour une seule question
  const byKey = new Map();
  for (const plan of pending) {
    const k = planKey(plan.kind, plan.name);
    if (!byKey.has(k)) byKey.set(k, plan);
  }
  const uniquePlans = [...byKey.values()];
  if (!uniquePlans.length) return manual;

  const body = `
    <form>
      <p>Certaines entrées n'ont pas trouvé de correspondance certaine dans les compendiums.
      Choisissez la meilleure correspondance, ou conservez un item brut :</p>
      ${uniquePlans.map((plan) => renderRow(plan, suggestMatches(index, { type: plan.kind, name: plan.name }))).join('<hr/>')}
    </form>`;

  return new Promise((resolve) => {
    const dialog = new foundry.applications.api.DialogV2({
      window: { title: 'savaged.us — Arbitrage des correspondances' },
      content: body,
      buttons: [
        {
          action: 'confirm',
          icon: 'fas fa-check',
          label: 'Importer',
          callback: (event, button) => {
            const form = button.form ?? event.target.closest('dialog')?.querySelector('form')
              ?? button.element?.querySelector?.('form');
            if (!form) { resolve(manual); return; }
            for (const sel of form.querySelectorAll('select[data-plan]')) {
              manual[sel.dataset.plan] = sel.value;
            }
            resolve(manual);
          },
        },
      ],
      close: () => resolve(manual),
      modal: true,
    });
    dialog.render(true);
  });
}

/* ------------------------------------------------------------------ */
/* Résolution d'une entrée                                            */
/* ------------------------------------------------------------------ */

/**
 * Résout un plan : choix manuel > compendium déterministe > item brut.
 * Remplit `report` et retourne l'objet document source (toObject) ou un
 * document brut de substitution.
 */
async function resolvePlan(index, plan, manual, report) {
  const key = planKey(plan.kind, plan.name);

  // 1. Choix manuel issu du dialogue
  const manualChoice = manual[key];
  if (manualChoice && manualChoice !== RAW_CHOICE) {
    try {
      const doc = await fromUuid(manualChoice);
      if (doc) {
          report.resolved.push({ name: plan.name, kind: plan.kind, source: rec.packLabel, packId: rec.pack, duplicates: dups });
        return doc.toObject();
      }
    } catch (err) {
      console.warn('savagedus-companion | UUID manuel introuvable:', manualChoice, err);
    }
  }

  // 2. Compendium déterministe (cascade alias > nom complet > écorché)
  const rec = findRecord(index, { type: plan.kind, name: plan.name });
  if (rec) {
    let doc = null;
    try {
      doc = await fromUuid(rec.uuid);
    } catch (err) {
      console.warn('savagedus-companion | fromUuid échoué:', rec.uuid, err);
    }
    if (doc) {
      const dups = getDuplicates(index, plan.name)
        .map((d) => d.packLabel)
        .filter((l) => l !== rec.packLabel);
      report.resolved.push({ name: plan.name, kind: plan.kind, source: rec.packLabel, duplicates: dups });
      return doc.toObject();
    }
  }

  // 3. Item brut
  report.raw.push({ name: plan.name, kind: plan.kind });
  return null;
}

/* ------------------------------------------------------------------ */
/* Builders : transformation d'un plan en item SWADE                   */
/* ------------------------------------------------------------------ */

function buildRawItem(plan) {
  const p = plan.payload ?? {};
  switch (plan.kind) {
    case 'edge':
      return { name: plan.name, type: 'edge', system: { description: p.description ?? '' } };
    case 'hindrance':
      return {
        name: plan.name,
        type: 'hindrance',
        system: {
          description: p.description ?? '',
          ...(plan.hindranceInfo ? { major: plan.hindranceInfo.major } : {}),
        },
      };
    case 'ability':
      return { name: plan.name, type: 'ability', system: { description: p.description ?? '' } };
    case 'armor':
      return {
        name: plan.name,
        type: 'armor',
        system: {
          armor: { value: p.armor ?? 0 },
          weight: p.weight ?? 0,
          equipped: !!p.equipped,
        },
      };
    case 'shield':
      return {
        name: plan.name,
        type: 'shield',
        system: { parry: { value: p.parry ?? 0 }, weight: p.weight ?? 0, equipped: !!p.equipped },
      };
       case 'armor':
      return {
        name: plan.name,
        type: 'armor',
        system: {
          armor: Number(p.armor ?? 0) || 0, // nombre simple en 6.0.4
          weight: Number(p.weight ?? 0) || 0,
          equipped: !!p.equipped,
        },
      };
    case 'weapon': {
      const prof = (Array.isArray(p.profiles) && p.profiles.length) ? p.profiles[p.activeProfile ?? 0] : {};
      return {
        name: plan.name,
        type: 'weapon',
        system: {
          damage: toDamageFormula(prof.damage ?? p.damage ?? ''),
          range: p.range ?? prof.range ?? '',
          ...(p.ap ? { ap: p.ap } : {}),
          weight: p.weight ?? 0,
          equipped: !!p.equipped,
          notes: p.notes ?? '',
        },
      };
    }
    case 'power':
      return { name: plan.payload?.customName ?? plan.name, type: 'power', system: {} };
    case 'gear':
      return {
        name: plan.name,
        type: 'gear',
        system: { weight: p.weight ?? 0, quantity: p.quantity ?? 1, equipped: !!p.equipped },
      };
    default:
      return { name: plan.name, type: 'gear', system: {} };
  }
}

/** Applique les personnalisations par type après résolution compendium. */
function decorate(doc, plan) {
  const p = plan.payload ?? {};
  switch (plan.kind) {
    case 'power': {
      doc.name = p.customName || doc.name || plan.name;
      const trapping = p.customDescription || p.description || '';
      if (trapping) {
        doc.system = doc.system ?? {};
        doc.system.notes = doc.system.notes
          ? `${doc.system.notes}<hr/><p><em>${trapping}</em></p>`
          : trapping;
        if (typeof doc.system.description === 'string' && doc.system.description) {
          doc.system.description += `<hr/><p><em>${trapping}</em></p>`;
        }
      }
      break;
    }
    case 'hindrance':
      if (plan.hindranceInfo) {
        doc.system = doc.system ?? {};
        doc.system.major = plan.hindranceInfo.major;
        if (plan.hindranceInfo.detail) {
          doc.system.description = `${doc.system.description ?? ''}<p><em>${plan.hindranceInfo.detail}</em></p>`;
        }
      }
      break;
    case 'armor':
      doc.system = doc.system ?? {};
      doc.system.equipped = !!p.equipped;
      break;
    case 'weapon':
      doc.system = doc.system ?? {};
      doc.system.equipped = !!p.equipped;
      doc.system.damage = doc.system.damage || toDamageFormula(p.damage ?? '');
      break;
    case 'shield':
      doc.system = doc.system ?? {};
      doc.system.equipped = !!p.equipped;
      break;
    case 'gear':
      doc.system = doc.system ?? {};
      doc.system.equipped = !!p.equipped;
      doc.system.quantity = p.quantity ?? 1;
      break;
    default:
      break;
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* Déduplication post-import                                           */
/* ------------------------------------------------------------------ */

/**
 * SWADE 6.x accorde automatiquement certaines actions/compétences quand
 * un item compendium est créé. Cette passe retire les doublons, en
 * conservant l'item ayant le dé (ou les données) le plus élevé.
 */
export function deduplicateItems(actor) {
  const seen = new Map();
  const toDelete = [];
  for (const item of actor.items) {
    const key = `${item.type}:${slugify(item.name)}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, item);
      continue;
    }
    const side = (it) => (it.system?.die?.sides ?? 0) + (it.system?.die?.modifier ?? 0);
    const keep = side(item) >= side(prev) ? item : prev;
    const drop = keep === item ? prev : item;
    seen.set(key, keep);
    toDelete.push(drop.id);
  }
  if (toDelete.length) {
    actor.deleteEmbeddedDocuments('Item', toDelete);
    console.log('savagedus-companion | doublons supprimés:', toDelete.length);
  }
  return toDelete.length;
}

/* ------------------------------------------------------------------ */
/* Import principal                                                    */
/* ------------------------------------------------------------------ */

/**
 * Importe un export savaged.us en acteur SWADE.
 * @param {object} data export JSON brut savaged.us
 * @param {object} [options] { skipDialog, manual } pour rejouer un import
 * @returns {Promise<Actor>}
 */
export async function importCharacter(data, options = {}) {
  if (!data?.name || typeof data !== 'object') {
    ui.notifications.error('savagedus-companion | fichier invalide (personnage sans nom).');
    throw new Error('Export savaged.us invalide.');
  }

  // PC (character) par défaut ; NPC accepté pour les alliedExtras
  const actorType = options.actorType === 'npc' ? 'npc' : 'character';

  const index = await buildIndex();
  const { plans, gearPlans } = collectRequests(data);
  const allPlans = [...plans, ...gearPlans];

  const report = { resolved: [], raw: [], pendingKeys: new Set() };

  // Étape 1 : identifier les entrées sans correspondance déterministe
  const pending = [];
  const seenPending = new Set();
  for (const plan of allPlans) {
    const key = planKey(plan.kind, plan.name);
    if (options.manual?.[key]) continue; // déjà arbitré manuellement
    if (findRecord(index, { type: plan.kind, name: plan.name })) continue;
    if (seenPending.has(key)) continue;
    seenPending.add(key);
    pending.push(plan);
  }

  // Étape 2 : arbitrage interactif
  const manual = options.skipDialog
    ? {}
    : await promptArbitration(index, pending);

  // Étape 3 : création de l'acteur « nu »
  const actor = await Actor.create({
    name: data.name,
    type: actorType,
    img: data.image || undefined,
    ...(data.imageToken ? { prototypeToken: { texture: { src: data.imageToken } } } : {}),
  });

  // Étape 4 : patch par chemins complets — JAMAIS de `system` partiel
  const updates = {};
  for (const attr of Array.isArray(data.attributes) ? data.attributes : []) {
    const sides = dieSides(attr.value);
    if (!sides) continue;
    updates[`system.attributes.${attr.name}.die.sides`] = sides;
    if (attr.mod) updates[`system.attributes.${attr.name}.die.modifier`] = attr.mod;
  }
  if (Number.isFinite(data.bennies)) {
    updates['system.bennies.value'] = data.bennies;
    updates['system.bennies.max'] = data.benniesMax ?? data.bennies;
  }
   if (data.wildcard !== undefined && actorType === 'character') {
    updates['system.wildcard'] = !!data.wildcard;
  }
  // Pour un NPC, le statut Wild Card se règle via l'option
  // « Wild Card ? » de la fiche (liste déroulante, pas un booléen)
  if (data.rankName) updates['system.rank'] = data.rankName.toLowerCase();
  // Pace : paceBase seulement (paceTotal inclut les mods raciaux déjà
  // portés par l'item ancestry — éviter le double comptage)
  if (Number.isFinite(data.paceBase)) updates['system.stats.pace.value'] = data.paceBase;
  if (data.background) {
    updates['system.details.biography.value'] = data.background;
  }
  if (data.age) updates['system.details.age'] = String(data.age);
  if (data.gender) updates['system.details.gender'] = data.gender;
  if (data.wealthFormatted) updates['system.details.wealth'] = data.wealthFormatted;
  if (Object.keys(updates).length) await actor.update(updates);

  // Étape 5 : résolution et constitution des items
  const items = [];
  for (const plan of allPlans) {
    let doc = await resolvePlan(index, plan, { ...options.manual, ...manual }, report);
    if (!doc) doc = buildRawItem(plan);
    else doc = decorate(doc, plan);
    if (doc?.name) items.push(doc);
  }

  // Compétences : items bruts directs (valeur + attribut lié)
  for (const sk of Array.isArray(data.skills) ? data.skills : []) {
    if (!sk?.name || IGNORED_NAMES.has(slugify(sk.name))) continue;
    const sides = dieSides(sk.value);
    if (sides < 4) continue; // non entraînée
    items.push({
      name: sk.name,
      type: 'skill',
      system: {
        attribute: sk.attribute || '',
        die: { sides, ...(sk.mod ? { modifier: sk.mod } : {}) },
      },
    });
  }

  if (items.length) {
    const created = await actor.createEmbeddedDocuments('Item', items);
    // Post-traitement : équips et flags complémentaires éventuels
    const eqUpdates = created
      .filter((it) => it.system?.equipped !== undefined && typeof it.system.equipped === 'boolean')
      .map((it) => ({ _id: it.id, 'system.equipped': it.system.equipped }));
    if (eqUpdates.length) await actor.updateEmbeddedDocuments('Item', eqUpdates);
  }

  // Étape 6 : dédoublonnage post-grants SWADE 6.x
  const removed = deduplicateItems(actor);

  // Étape 7 : récapitulatif
  const resolvedCount = report.resolved.length;
  const rawCount = report.raw.length;
  console.log(
    `savagedus-companion | ${data.name} importé : ${items.length + rawCount} items `
    + `(${resolvedCount} compendium, ${rawCount} bruts), ${removed} doublons purgés.`,
  );
  if (report.raw.length) {
    console.warn('savagedus-companion | items bruts (sans compendium) :',
      report.raw.map((r) => `${r.kind}/${r.name}`));
  }
  console.table(report.resolved.map((r) => ({
    Nom: r.name, Type: r.kind, Source: r.packId ?? r.source, Doublons: (r.duplicates ?? []).join(', '),
  })));
  ui.notifications.info(
    `savagedus-companion | ${data.name} importé : ${resolvedCount} depuis compendiums, `
    + `${rawCount} bruts, ${removed} doublons purgés.`,
  );

  // Rafraîchit la sidebar (le bouton est maintenu par l'observer de main.js)
    // Rafraîchit la sidebar (le bouton est maintenu par l'observer de main.js)
  try {
    ui.actors?.render(true);
  } catch (err) {
    console.warn('savagedus-companion | rafraîchissement sidebar impossible:', err);
  }

  return actor; // <-- la ligne manquante
}
