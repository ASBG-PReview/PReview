import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const recipe = ['Dockerfile', 'gradlew', 'gradle/wrapper/gradle-wrapper.jar',
  'gradle/wrapper/gradle-wrapper.properties', 'settings.gradle', 'build.gradle'];

const localOnly = new Set(['.gitignore', 'gradlew.bat', 'README.md', 'compose.yaml']);

function tree(ref) {
  const raw = execFileSync('git', ['ls-tree', '-rz', ref, '--', 'preview-api'], { maxBuffer: 64 * 1024 * 1024 });
  const files = new Map();
  for (const entry of new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, kind, oid] = entry.slice(0, tab).split(' ');
    const name = entry.slice(tab + 1);
    if (!name.startsWith('preview-api/')) throw new Error('Unexpected Git path');
    files.set(name.slice('preview-api/'.length), { mode, kind, oid });
  }
  return files;
}

export function stage(base, destination) {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('Expected a full base SHA');
  const head = tree('HEAD');
  const parent = tree(base);
  const bootstrap = !parent.has('Dockerfile');
  mkdirSync(destination);
  for (const name of new Set([...recipe, ...head.keys()])) {
    if (localOnly.has(name)) continue;
    if (!recipe.includes(name) && !name.startsWith('src/')) throw new Error('Unreviewed build input: ' + name);
    if (name.includes('\\') || name.split('/').some(part => ['.', '..', ''].includes(part))) {
      throw new Error('Unsafe build path: ' + name);
    }
    const file = head.get(name);
    if (file?.kind !== 'blob' || !['100644', '100755'].includes(file.mode)) {
      throw new Error('Expected a committed regular file: ' + name);
    }
    // The initial read-only build introduces Docker and its Gradle verification task together.
    // Publication independently requires identical recipes on main and both PR parents.
    const initialRecipe = bootstrap && ['Dockerfile', 'build.gradle'].includes(name);
    if (recipe.includes(name) && !initialRecipe) {
      const trusted = parent.get(name);
      if (file.oid !== trusted?.oid || file.mode !== trusted.mode) {
        throw new Error('Build recipe differs from base: ' + name);
      }
    }
    const path = join(destination, name);
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'wx');
    try {
      execFileSync('git', ['cat-file', 'blob', file.oid], { stdio: ['ignore', fd, 'inherit'] });
    } finally {
      closeSync(fd);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  stage(process.argv[2], process.argv[3]);
}
