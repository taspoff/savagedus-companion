import { buildIndex } from './matcher.js';
import { importCharacter } from './importer.js';

Hooks.once('init', () => {
  game.modules.get('savagedus-companion').api = { importCharacter, buildIndex };
});

Hooks.on('renderActorDirectory', (app, html) => {
  const btn = $(`<button><i class="fas fa-file-import"></i> Savaged.us</button>`);
  btn.on('click', async () => {
    const file = await new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json';
      input.onchange = () => resolve(input.files[0]);
      input.click();
    });
    const data = JSON.parse(await file.text());
    const report = [];
    ui.notifications.info('Indexation des compendiums...');
    await buildIndex();
    const actor = await importCharacter(data, report);
    ui.notifications.ui?.notifications.pop();
    if (report.length) {
      const li = report.map(r => `<li>${r}</li>`).join('');
      new Dialog({ title: 'Import terminé — éléments non trouvés',
        content: `<p>Acteur <strong>${actor.name}</strong> créé.</p><ul>${li}</ul>`,
        buttons: { ok: { label: 'OK' } } }).render(true);
    } else {
      ui.notifications.notify(`Acteur ${actor.name} importé avec succès !`);
    }
    actor.sheet.render(true);
  });
  html.find('.directory-footer').append(btn);
});
