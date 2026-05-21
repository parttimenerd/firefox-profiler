/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Build the GraalVM WASM converter (jafar) and copy artifacts into
// src/profile-logic/import/jfr-wasm/. Sources live in
// src/profile-logic/import/jfr-wasm/jafar/.

import { spawnSync } from 'child_process';
import { copyFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.resolve(
  __dirname,
  '..',
  'src/profile-logic/import/jfr-wasm'
);
const jafarDir = path.join(wasmDir, 'jafar');

if (!existsSync(path.join(jafarDir, 'pom.xml'))) {
  console.error(`No pom.xml found at ${jafarDir}`);
  process.exit(1);
}

console.log(`Building jafar WASM in ${jafarDir} ...`);
const debugBuild = process.argv.includes('--debug');
const mvnArgs = ['-q', 'package', '-DskipTests'];
if (debugBuild) {
  // Activates the `debug` Maven profile in jafar/pom.xml — adds DWARF
  // + WASM `name` section + parameter info so browser profilers/debuggers
  // can show readable Java method names. The WASM grows from ~12 MB to
  // ~22 MB; runtime speed is unchanged. Useful for profiling/debugging
  // the converter; never used in CI/Pages builds.
  mvnArgs.push('-Pdebug');
  console.log('  (debug build: -Pdebug — keeps Java symbol names)');
}
const r = spawnSync('mvn', mvnArgs, {
  cwd: jafarDir,
  stdio: 'inherit',
});
if (r.status !== 0) {
  console.error(`mvn package failed (exit ${r.status})`);
  process.exit(r.status ?? 1);
}

for (const name of ['jfrtofp.js', 'jfrtofp.js.wasm']) {
  const src = path.join(jafarDir, 'web', name);
  const dst = path.join(wasmDir, name);
  if (!existsSync(src)) {
    console.error(`Build artifact missing: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dst);
  console.log(`Copied ${name} → ${path.relative(process.cwd(), dst)}`);
}

console.log('Done.');
