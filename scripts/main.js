import { buildIndex } from './matcher.js';
import { importCharacter } from './importer.js';

const MODULE_ID = 'savagedus-companion';

Hooks.once('init', () => {
  game.modules.get(MODULE_ID).api = { importCharacter, buildIndex };
});

/**
 * Retourne un HTMLElement à partir du paramètre html d'un hook,
 * qu'il soit un jQuery (Foundry <= 11) ou un élément natif (Foundry 12/13).
 */
function resolveHtml(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

async function pickFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => input.files.length ? resolve(input.files[0]) : reject(new Error('Aucun fichier sélectionné'));
    input.onerror = () => reject(new Error('Erreur de lecture du fichier'));
    input.click();
  });
}

async function runImport(actorId) {
  try {
    const file = await pickFile();
    const data = JSON.parse(await file.text());

    ui.notifications.info('Savaged.us : indexation des compendiums en cours...');
    await buildIndex();

    const report = [];
    const actor = await importCharacter(data, report);

    const dialogContent = `
      <p>Acteur <strong>${actor.name}</strong> importé avec succès.</p>
      ${report.length ? `
        <p><strong>${report.length}</strong> élément(s) sans correspondance dans les compendiums (créés en items bruts) :</p>
        <ul>${report.map((r) => `<li>${r}</li>`).join('')}</ul>` : '<p>Toutes les correspondances ont été résolues.</p>'}
    `;
    new foundry.applications.api.DialogV2.wait({
      window: { title: 'Import Savaged.us' },
      content: dialogContent,
      buttons: [{ action: 'ok', label: 'OK', default: true }],
    });
    actor.sheet.render(true);
  } catch (err) {
    console.error(`${MODULE_ID} | Erreur d'import`, err);
    ui.notifications.error(`Savaged.us : échec de l'import — ${err.message}`);
  }
}

Hooks.on('renderActorDirectory', (app, html) => {
  if (!game.modules.get(MODULE_ID)?.active) return;
  const el = resolveHtml(html);
  if (!el) return;

  // Évite les doublons de bouton lors des re-rendus
  if (el.querySelector('.savagedus-import-btn')) return;

  const footer = el.querySelector('.directory-footer');
  if (!footer) return;

  const btn = document.createElement('button');
  btn.className = 'savagedus-import-btn';
  btn.style.flex = '0 0 auto';
  btn.innerHTML = '<i class="fas fa-file-import"></i> Savaged.us';
  btn.title = "Importer un personnage depuis un export savaged.us";
  btn.addEventListener('click', runImport);
  footer.appendChild(btn);
});
