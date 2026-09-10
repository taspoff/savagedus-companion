import { buildIndex, findRecord, suggestMatches } from './matcher.js';
import { importCharacter, collectRequests } from './importer.js';

const MODULE_ID = 'savagedus-companion';

const PRESELECT_THRESHOLD = 0.75; // pré-coche la meilleure suggestion si score >= 75 %
const MIN_SUGGESTION_SCORE = 0.3;
const SUGGESTION_COUNT = 5;

Hooks.once('init', () => {
  game.modules.get(MODULE_ID).api = { importCharacter, collectRequests, buildIndex };

  game.settings.register(MODULE_ID, 'priorityPacks', {
    name: 'Priorité des compendiums',
    hint: 'Ids des packs, du plus prioritaire au moins prioritaire, séparés par des virgules. Les packs achetés doivent précéder les SRD gratuits. Vide = ordre par défaut.',
    scope: 'world',
    config: true,
    type: String,
    default: DEFAULT_PRIORITY_ORDER.join(','),
  });
});

/** Retourne un HTMLElement à partir du paramètre html d'un hook (jQuery ou natif). */
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
    input.onchange = () =>
      input.files.length ? resolve(input.files[0]) : reject(new Error('Aucun fichier sélectionné'));
    input.onerror = () => reject(new Error('Erreur de lecture du fichier'));
    input.click();
  });
}

/**
 * Affiche la liste des éléments à arbitrer et retourne la map des choix manuels
 * { "<type>:<slug>" : "<uuid du compendium choisi>" }.
 */
function reviewDialog(toReview) {
  return new Promise((resolve) => {
    const rows = toReview
      .map((r, i) => {
        const options = r.suggestions
          .map((s, j) => {
            const pre = j === 0 && s.score >= PRESELECT_THRESHOLD ? ' selected' : '';
            return `<option value="${s.uuid}"${pre}>${s.name} — ${Math.round(s.score * 100)} %</option>`;
          })
          .join('');
        return `
          <div style="margin-bottom:8px">
            <label><strong>${r.type}</strong>&nbsp;: ${r.name}</label>
            <select data-key="${r.key}" style="width:100%">
              <option value="">— Aucun (créer en item brut) —</option>
              ${options}
            </select>
          </div>`;
      })
      .join('');

    let dlg;
    dlg = new foundry.applications.api.DialogV2({
      window: { title: 'Correspondances à valider' },
      content: `<p>${toReview.length} élément(s) nécessitent votre arbitrage :</p>${rows}`,
      buttons: [
        {
          action: 'ok',
          label: 'Importer',
          default: true,
          callback: () => {
            const picks = {};
            const el = resolveHtml(dlg.element);
            el?.querySelectorAll('select[data-key]').forEach((sel) => {
              if (sel.value) picks[sel.dataset.key] = sel.value;
            });
            resolve(picks);
          },
        },
      ],
    });
    dlg.render(true);
  });
}

async function runImport() {
  try {
    const file = await pickFile();
    const data = JSON.parse(await file.text());

    ui.notifications.info('Savaged.us : indexation des compendiums en cours...');
    await buildIndex();

    // Pré-résolution : tout ce qui matche automatiquement ne pose pas de question
    const requests = collectRequests(data);
    const manual = {};
    const toReview = [];

    for (const req of requests) {
      if (findRecord(req.type, req.name)) continue; // résolution automatique OK
      const suggestions = suggestMatches(req.type, req.name, SUGGESTION_COUNT, MIN_SUGGESTION_SCORE);
      toReview.push({ ...req, suggestions });
    }

    if (toReview.length) {
      Object.assign(manual, await reviewDialog(toReview));
    }

    const report = [];
    const actor = await importCharacter(data, report, manual);

    const dialogContent = `
      <p>Acteur <strong>${actor.name}</strong> importé avec succès.</p>
      ${
        report.length
          ? `<p><strong>${report.length}</strong> élément(s) sans correspondance retenue (créés en items bruts) :</p>
             <ul>${report.map((r) => `<li>${r}</li>`).join('')}</ul>`
          : '<p>Toutes les correspondances ont été résolues.</p>'
      }
    `;
    new foundry.applications.api.DialogV2({
      window: { title: 'Import Savaged.us' },
      content: dialogContent,
      buttons: [{ action: 'ok', label: 'OK', default: true }],
    }).render(true);

    if (report.length) console.warn(`${MODULE_ID} | Non-correspondances :`, report);
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
  if (el.querySelector('.savagedus-import-btn')) return;

  const footer = el.querySelector('.directory-footer');
  if (!footer) return;

  const btn = document.createElement('button');
  btn.className = 'savagedus-import-btn';
  btn.style.flex = '0 0 auto';
  btn.innerHTML = '<i class="fas fa-file-import"></i> Savaged.us';
  btn.title = 'Importer un personnage depuis un export savaged.us';
  btn.addEventListener('click', runImport);
  footer.appendChild(btn);
});
