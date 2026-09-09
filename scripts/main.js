import { buildIndex } from './matcher.js';
import { importCharacter } from './importer.js';

Hooks.once('init', () => {
  game.modules.get('savagedus-companion').api = { importCharacter, buildIndex };
});

Hooks.on('renderActorDirectory', (app, html) => {
  const el = html instanceof HTMLElement ? html : html?.[0];
  const footer = el?.querySelector('.directory-footer');
  if (!footer) return;
  const btn = document.createElement('button');
  btn.innerHTML = '<i class="fas fa-file-import"></i> Savaged.us';
  btn.addEventListener('click', async () => {
    // ... même logique d'import qu'avant (sélection fichier, buildIndex, importCharacter) ...
  });
  footer.appendChild(btn);
});

