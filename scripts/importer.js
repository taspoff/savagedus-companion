import { match } from './matcher.js';

const attrMap = { agility:'agility', smarts:'smarts', spirit:'spirit', strength:'strength', vigor:'vigor' };

export async function importCharacter(data, report = []) {
  const system = {
    attributes: {}, details: {}, ...{}
  };
  for (const a of data.attributes) {
    system.attributes[attrMap[a.name]] = {
      die: { sides: a.dieValue, modifier: a.mod }, wild-die... // copier le schéma SWADE
    };
  }
  system.details.currency = data.wealth;
  system.details.biography = { value: `<p>${data.background}</p>` };
  system.details.species = { name: data.race };
  system.bennies = { value: data.bennies, max: data.benniesMax };
  system.advances = { rank: data.rankName };
  system.pace = { ground: data.paceTotal, running: { die: parseInt(data.runningDie.slice(1)) } };

  const actor = await Actor.implementation.create({
    name: data.name, type: 'character', system,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
  });

  const items = [];

  // --- Ancestry (grante automatiquement les capacités raciales) ---
  const ancestry = await match('ancestry', data.race, { report });
  if (ancestry) items.push(ancestry.toObject());

  // --- Compétences ---
  for (const sk of data.skills) {
    if (sk.name === '(Unskilled)' || sk.dieValue < 4) continue;
    const doc = await match('skill', sk.name, { report });
    const d = (doc?.toObject() ?? { name: sk.name, type: 'skill', system: {} });
    d.system ??= {};
    d.system.attribute = sk.attribute ? attrMap[sk.attribute] || '' : '';
    d.system.die = { sides: sk.dieValue, modifier: sk.mod };
    items.push(d);
  }

  // --- Handicaps : séparer base / sévérité / précision ---
  for (const h of data.hindrances) {
    const m = h.name.match(/^(.*?)\s*\((.*?),\s*(.*)\)$/); // "Phobia (minor, claustrophobie)"
    const base = m ? m[1] : h.name;
    const detail = m ? m[3] : '';
    const doc = await match('hindrance', base, { report });
    const d = (doc?.toObject() ?? { name: base, type: 'hindrance', system: {} });
    d.name += detail ? ` (${detail})` : '';
    d.system.severity = h.major ? 'major' : 'minor';
    d.system.major = h.major;
    items.push(d);
  }

  // --- Armes ---
  const dmg = (s) => s.replace(/str\+?/i, '@str');
  for (const w of data.weapons) {
    const p = w.profiles[w.activeProfile ?? 0];
    const doc = await match('weapon', w.name, { report });
    const d = (doc?.toObject() ?? { name: w.name, type: 'weapon', system: {} });
    d.system ??= {};
    Object.assign(d.system, {
      quantity: w.quantity, weight: w.weight, price: w.cost,
      damage: dmg(p.damage), range: p.range === 'Melee' ? '' : p.range,
      ap: p.ap, rof: p.rof ?? 0, minStr: w.minStr,
      equipStatus: w.equipped ? 3 : 1,
      notes: p.notes, ammo: p.shots > 0 ? 'Bolts' : '',
    });
    d.system.actions = { ...d.system.actions, trait: p.skillName };
    items.push(d);
  }

  // --- Armures (ignorer "(Unarmored)") ---
  for (const a of data.armor) {
    if (a.id === 0 || a.name === '(Unarmored)') continue;
    const doc = await match('armor', a.name, { report });
    const d = (doc?.toObject() ?? { name: a.name, type: 'armor', system: {} });
    d.system ??= {};
    Object.assign(d.system, {
      armor: a.armor, quantity: a.quantity, weight: a.weight,
      price: a.cost, minStr: a.minStr,
      equipStatus: a.equipped ? 3 : 1,
      locations: { head: a.coversHead, torso: a.coversTorso, legs: a.coversLegs, arms: a.coversArms },
    });
    items.push(d);
  }

  // --- Équipement divers ---
  for (const g of data.gear) {
    const doc = await match('gear', g.name, { report });
    const d = (doc?.toObject() ?? { name: g.name, type: 'gear', system: {} });
    d.system ??= {};
    Object.assign(d.system, { quantity: g.quantity, weight: g.weight, price: g.cost, notes: g.notes });
    items.push(d);
  }

  await actor.createEmbeddedDocuments('Item', items);
  return actor;
}
