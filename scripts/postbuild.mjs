import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const entries = ['cli.js', 'index.js', 'probe.js', 'benchmark.js'];
const shebang = '#!/usr/bin/env node\n';

for (const name of entries) {
  const target = path.join(distDir, name);
  const source = readFileSync(target, 'utf8');

  if (!source.startsWith('#!')) {
    writeFileSync(target, shebang + source);
  }
  chmodSync(target, 0o755);
  process.stderr.write(`[postbuild] entry prepared: ${target}\n`);
}