/**
 * savagedus-companion — scripts/main.js
 *
 * Amorçage du module : settings, bouton d'import dans le répertoire
 * des acteurs, lecture du fichier JSON exporté de savaged.us.
 */
'use strict';

import { importCharacter } from './importer.js';
import { invalidateIndex } from './matcher.js';

/* ------------------------------------------------------------------ */
/* Identité du module                                                  */
/* ------------------------------------------------------------------ */

const MODULE_ID = 'savagedus-companion';
const ICON_IMPORT = '<i class="fas fa-download"></i>';

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

/**
 * Résout un élément cible depuis un hook, en tolérant à la fois un
 * HTMLElement natif (Foundry v13) et un objet jQuery historique.
 */
function resolveHtml(html) {
  if (!html) return null;
  if (typeof html.querySelector === 'function') return html;
  if (html[0] && typeof html[0].querySelector === 'function') return html[0];
  return null;
}

/** Ouvre un sélecteur de fichier JSON et retourne l'objet parsé. */
/** Ouvre un sélecteur de fichier JSON et retourne l'objet parsé. */
function pickJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);

    const cleanup = () => input.remove();

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { cleanup(); resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        cleanup();
        try {
          resolve(JSON.parse(String(reader.result)));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => {
        cleanup();
        reject(reader.error ?? new Error('Lecture du fichier impossible.'));
      };
      reader.readAsText(file);
    });

    input.click();
  });
}
/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function registerSettings() {
  game.settings.register(MODULE_ID, 'priorityPacks', { /* inchangé */ });
  // Nouveau : marqueur de première configuration
  game.settings.register(MODULE_ID, 'configured', {
    scope: 'world',
    config: false,
    type: Boolean,
    default: false,
  });
}

/** Dialogue de priorisation des packs (première fois ou à la demande). */
async function showPackPrioritizer() {
  const { detectPackGroups } = await import('./matcher.js');
  const groups = detectPackGroups();
  if (!groups.length) return;

  const renderList = () => {
    const items = groups.map((g, i) => `
      <li data-index="${i}" style="display:flex;align-items:center;gap:6px;padding:2px 0;">
        <span style="flex:1;">${g.label} <small style="color:grey;">(${g.namespace} · ${g.packs} packs)</small></span>
        <button type="button" data-move="up" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
        <button type="button" data-move="down" ${i === groups.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
      </li>`).join('');
    const ol = document.querySelector('.savagedus-packlist');
    if (ol) ol.innerHTML = items; // re-render sur déplacement
    else return items;
    // rattacher les listeners après chaque re-render
    for (const btn of ol.querySelectorAll('button[data-move]')) {
      btn.addEventListener('click', () => {
        const li = btn.closest('li');
        const i = Number(li.dataset.index);
        const j = btn.dataset.move === 'up' ? i - 1 : i + 1;
        [groups[i], groups[j]] = [groups[j], groups[i]];
        renderList();
      });
    }
  };

  return new Promise((resolve) => {
    const dlg = new foundry.applications.api.DialogV2({
      window: { title: 'savaged.us — Priorisation des compendiums' },
      content: `
        <style>.savagedus-packlist{list-style:none;padding:0;margin:8px 0;}</style>
        <p>Le module relie les entrées savaged.us à vos compendiums.
        Classez-les du <strong>plus prioritaire</strong> au moins prioritaire :
        en cas de doublon, l'entrée viendra du pack le plus haut
        (l'ordre actuel est une suggestion, ajustez librement).</p>
        <ol class="savagedus-packlist">${renderList()}</ol>`,
      buttons: [
        {
          action: 'save',
          icon: 'fas fa-check',
          label: 'Enregistrer',
          callback: () => resolve('save'),
        },
        {
          action: 'skip',
          label: 'Garder les défauts',
          callback: () => resolve('skip'),
        },
      ],
      close: () => resolve(null),
      modal: true,
    });
    dlg.render(true).then(() => {
      const ol = dlg.element.querySelector('.savagedus-packlist');
      // listeners initiaux (renderList a déjà posé le HTML dans le template)
      wireList(ol);
    });

    // factorisation du re-bind
    function wireList(ol) {
      for (const btn of ol.querySelectorAll('button[data-move]')) {
        btn.addEventListener('click', () => {
          const li = btn.closest('li');
          const i = Number(li.dataset.index);
          const j = btn.dataset.move === 'up' ? i - 1 : i + 1;
          if (j < 0 || j >= groups.length) return;
          [groups[i], groups[j]] = [groups[j], groups[i]];
          ol.innerHTML = groups.map((g, k) => `
            <li data-index="${k}" style="display:flex;align-items:center;gap:6px;padding:2px 0;">
              <span style="flex:1;">${g.label} <small style="color:grey;">(${g.namespace} · ${g.packs} packs)</small></span>
              <button type="button" data-move="up" ${k === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
              <button type="button" data-move="down" ${k === groups.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
            </li>`).join('');
          wireList(ol);
        });
      }
    }
    // mémorise l'état final pour le callback "Enregistrer"
    dlg._getOrder = () => groups.map((g) => g.namespace);
  }).then(async (result) => {
    if (result !== 'save') {
      // même en "skip", on marque configuré pour ne plus reposser la question
      await game.settings.set(MODULE_ID, 'configured', true);
      return;
    }
    await game.settings.set(MODULE_ID, 'priorityPacks', groups.map((g) => g.namespace).join(','));
    await game.settings.set(MODULE_ID, 'configured', true);
    ui.notifications.info(`${MODULE_ID} | priorité des compendiums enregistrée.`);
    invalidateIndex(); // l'index sera reconstruit avec le nouvel ordre
  });
}

/* ------------------------------------------------------------------ */
/* Bouton d'import dans le répertoire des acteurs                      */
/* ------------------------------------------------------------------ */

const IMPORT_BUTTON_HTML = `
  <button type="button" class="header-action savagedus-import"
          data-action="savagedusImport" data-tooltip="Importer depuis savaged.us"
          aria-label="Importer depuis savaged.us">
    ${ICON_IMPORT}
  </button>`;

function injectImportButton(html) {
  const header = html.querySelector('.directory-header .action-buttons')
    ?? html.querySelector('.action-buttons')
    ?? html.querySelector('.directory-header')
    ?? html.querySelector('header')
    ?? (html.classList?.contains('action-buttons') ? html : null);
  if (!header) return;
  if (header.querySelector('.savagedus-import')) return; // déjà injecté
  header.insertAdjacentHTML('beforeend', IMPORT_BUTTON_HTML);
  header.querySelector('.savagedus-import')
    .addEventListener('click', onImportClick);
}

/**
 * Trouve le conteneur de boutons de l'onglet Acteurs, quel que soit
 * l'id réel du répertoire dans ce build de Foundry.
 */
function findActionHost() {
  return document.querySelector('#actors .action-buttons')
    ?? document.querySelector('header.directory-header .action-buttons')
    ?? document.querySelector('.directory-header .action-buttons');
}

function tryInject() {
  const host = findActionHost();
  if (host) injectImportButton(host.parentElement ?? host);
}

/** Fenêtre d'information + choix PC / PNJ avant l'import. */
async function showIntroDialog() {
  return new Promise((resolve) => {
    const dlg = new foundry.applications.api.DialogV2({
      window: { title: 'savaged.us — Import de personnage' },
      content: `
        <style>
          .savagedus-intro p { margin: 0.4em 0; }
          .savagedus-intro .choice { display: flex; gap: 8px; justify-content: center; margin-top: 10px; }
        </style>
        <div class="savagedus-intro">
          <p><strong>Comment ça marche :</strong></p>
          <p>1. Sur <em>savaged.us</em>, ouvrez votre personnage puis
             <em>Options → Export → JSON</em>.</p>
          <p>2. Sélectionnez ici le fichier téléchargé.</p>
          <p>3. Les objets, atouts, handicaps et pouvoirs sont rattachés
             automatiquement à vos compendiums (priorité aux packs
             Pathfinder Savage, puis au SRD).</p>
          <p><em>Les entrées sans correspondance certaine vous seront
             proposées avec des suggestions de correspondance.</em></p>
          <p><strong>Type d'acteur à créer :</strong></p>
          <div class="choice">
            <button type="button" data-choice="character"
              style="flex:1;"><i class="fas fa-user"></i>&nbsp; Personnage (PC)</button>
            <button type="button" data-choice="npc"
              style="flex:1;"><i class="fas fa-dragon"></i>&nbsp; Figure (NPC)</button>
          </div>
        </div>`,
      // DialogV2 impose au moins un bouton : Annuler sert de sortie
      // propre (Esc/croix passent aussi par close ci-dessous)
      buttons: [
        {
          action: 'cancel',
          icon: 'fas fa-times',
          label: 'Annuler',
          callback: () => resolve(null),
        },
      ],
      close: () => resolve(null),
      modal: true,
    });
    dlg.render(true).then(() => {
      for (const btn of dlg.element.querySelectorAll('button[data-choice]')) {
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          const choice = btn.dataset.choice;
          dlg.close({ force: true }); // déclenche close() -> resolve(null)...
          resolve(choice);            // ...mais la première résolution gagne
        });
      }
    });
  });
}

async function onImportClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const actorType = await showIntroDialog();
  if (!actorType) return; // fenêtre fermée sans choix

  let data;
  try {
    data = await pickJsonFile();
  } catch (err) {
    console.error(`${MODULE_ID} | lecture du fichier échouée:`, err);
    ui.notifications.error(`${MODULE_ID} | fichier JSON illisible.`);
    return;
  }
  if (!data) return; // sélection annulée

  try {
    const actor = await importCharacter(data, { actorType });
    if (actor) {
      ui.notifications.info(`${MODULE_ID} | ${actor.name} importé avec succès.`);
    } else {
      // l'import s'est déroulé mais l'acteur n'a pas été retourné —
      // regarder le rapport console, l'acteur est probablement créé
      console.warn(`${MODULE_ID} | import terminé mais acteur non retourné (voir rapport console).`);
      ui.notifications.info(`${MODULE_ID} | import terminé (rapport en console).`);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | import échoué:`, err);
    ui.notifications.error(`${MODULE_ID} | import échoué (voir console).`);
  }
};
/* ------------------------------------------------------------------ */
/* Amorçage                                                            */
/* ------------------------------------------------------------------ */

Hooks.once('init', () => {
  registerSettings();
});

Hooks.once('ready', async () => {
  if (!game.modules.get(MODULE_ID)?.active) return;
  console.log(`${MODULE_ID} | prêt (Foundry ${game.version})`);
  tryInject();

  // Surveillance permanente : si l'en-tête de l'onglet Acteurs est
  // recréé (re-rendu, import, changement d'onglet), on ré-injecte.
  // Observer sur document.body : indépendant des ids/classes du build.
  const observer = new MutationObserver(() => {
    if (document.querySelector('.savagedus-import')) return;
    tryInject();
  });
  observer.observe(document.body, { childList: true, subtree: true });
    // Première configuration : proposer la priorisation des packs
  if (!game.settings.get(MODULE_ID, 'configured')) {
    showPackPrioritizer();
  }
});
