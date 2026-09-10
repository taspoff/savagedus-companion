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
  if (typeof html.querySelector === 'function') return html;      // natif v13
  if (html[0] && typeof html[0].querySelector === 'function') return html[0]; // jQuery
  return null;
}

/** Ouvre un sélecteur de fichier JSON et retourne l'objet parsé. */
function pickJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);

    const cleanup = () => {
      input.remove();
      window.removeEventListener('focus', onFocusWindow, true);
    };
    const onFocusWindow = () => {
      // Fermeture du sélecteur sans choix : résout null après un délai court
      setTimeout(() => {
        if (document.body.contains(input)) { cleanup(); resolve(null); }
      }, 500);
    };
    window.addEventListener('focus', onFocusWindow, true);

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { cleanup(); resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          cleanup();
          resolve(JSON.parse(String(reader.result)));
        } catch (err) {
          cleanup();
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
  console.debug('savagedus-companion | injectImportButton, header =', !!header);
  if (!header) return;
  if (header.querySelector('.savagedus-import')) return; // déjà injecté
  header.insertAdjacentHTML('beforeend', IMPORT_BUTTON_HTML);
  header.querySelector('.savagedus-import')
    .addEventListener('click', onImportClick);
}

async function onImportClick(event) {
  event.preventDefault();
  event.stopPropagation();

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
    const actor = await importCharacter(data);
    ui.notifications.info(
      `${MODULE_ID} | ${actor.name} importé avec succès.`,
    );
  } catch (err) {
    console.error(`${MODULE_ID} | import échoué:`, err);
    ui.notifications.error(`${MODULE_ID} | import échoué (voir console).`);
  }
}

/* ------------------------------------------------------------------ */
Hooks.once('init', () => {
  registerSettings();
});

/** Injecte le bouton dans l'onglet Acteurs si le DOM existe. */
function tryInject() {
  const root = document.querySelector('#actors');
  console.debug('savagedus-companion | tryInject appelé');
  if (root) injectImportButton(root);
}

// Injection principale : au chargement du monde, le DOM existe déjà
Hooks.once('ready', () => {
  if (!game.modules.get(MODULE_ID)?.active) return;
  tryInject();
  console.log(`${MODULE_ID} | prêt (Foundry ${game.version})`);
});

// Repli : si l'onglet est re-rendu, on ré-injecte (le garde
// anti-double-injection de injectImportButton empêche les doublons)
for (const hook of ['renderActorsTab', 'renderActorsDirectory', 'renderSidebar']) {
  Hooks.on(hook, (app, html) => {
    const el = resolveHtml(html) ?? document.querySelector('#actors');
    if (el) injectImportButton(el);
  });
}
// En bas du fichier, rendre accessible à importer.js :
export function refreshImportButton() {
  const root = document.querySelector('#actors');
  if (root) injectImportButton(root);
}
