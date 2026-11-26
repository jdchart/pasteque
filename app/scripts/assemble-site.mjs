/* Assemble the published site in app/site/:
   - the React app (app/dist) at the root, so https://jdchart.github.io/pasteque/ opens it;
   - every classic page (ats-*.html, general-*.html) copied unchanged, so the
     addresses students already have keep working;
   - the old landing page as classique.html;
   - .nojekyll, so Pages serves the files as they are.
   Run with `npm run site` (builds first). */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(app, '..');
const dist = join(app, 'dist');
const out = join(app, 'site');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('app/dist/index.html is missing: run `npm run build` first.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(dist, out, { recursive: true });

const classic = readdirSync(repo).filter((f) => /^(ats|general)-.+\.html$/.test(f));
for (const f of classic) {
  if (existsSync(join(out, f))) { console.error('name clash with the app build: ' + f); process.exit(1); }
  cpSync(join(repo, f), join(out, f));
}
if (existsSync(join(repo, 'index.html'))) cpSync(join(repo, 'index.html'), join(out, 'classique.html'));
writeFileSync(join(out, '.nojekyll'), '');

console.log('site/ ready: app + ' + classic.length + ' classic page(s) + classique.html');
for (const f of classic) console.log('  ' + f);
