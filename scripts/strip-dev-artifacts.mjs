// Release build: source maps and the compiled tests are not something a consumer
// of the package needs. Tests live in tests/ now, so in practice this only strips
// maps, but the test pass stays in case a stray *.test.js ends up in dist/.
// Removing them also keeps the machine's build paths out of the published code.
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const target = path.join(dir, entry);
    if (statSync(target).isDirectory()) {
      if (entry === '.anyindex') {
        rmSync(target, { recursive: true, force: true });
        continue;
      }
      walk(target);
      continue;
    }
    if (entry.endsWith('.map') || entry.endsWith('.test.js') || entry.endsWith('.test.d.ts')) {
      rmSync(target, { force: true });
    }
  }
}

if (statSync(dist, { throwIfNoEntry: false }) !== undefined) {
  walk(dist);
  process.stderr.write('[strip] dev artifacts removed from dist\n');
}