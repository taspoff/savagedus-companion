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
  game.settings.register(MODULE_ID, 'priorityPacks', {
    name: 'Ordre de priorité des packs',
    hint: 'Ids de compendiums séparés par des virgules, du plus prioritaire '
      + 'au moins prioritaire (ex. "swpf-apg-2,swpf-apg,swpf-core-rules"). '
      + 'Surcharge la priorité par défaut.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
    onChange: () => invalidateIndex(),
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

Hooks.once('ready', () => {
  if (!game.modules.get(MODULE_ID)?.active) return;
  console.log(`${MODULE_ID} | prêt (Foundry ${game.version})`);

  // Injection initiale
  tryInject();

  // Surveillance permanente : si l'en-tête de l'onglet Acteurs est
  // recréé (re-rendu, import, changement d'onglet), on ré-injecte.
  // Observer sur document.body : indépendant des ids/classes du build.
  const observer = new MutationObserver(() => {
    if (document.querySelector('.savagedus-import')) return;
    tryInject();
  });
  observer.observe(document.body, { childList: true, subtree: true });
});
