import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Publisher } from './preview-publish.mjs';
import { readState, stateFiles } from './reconcile-preview-state.mjs';

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const prTag = /^pr-([1-9][0-9]*)-[0-9a-f]{40}$/;

function exclusive(version, number) {
  const tags = version.metadata?.container?.tags;
  return version.metadata?.package_type === 'container' && Array.isArray(tags) && tags.length > 0 &&
    tags.every(tag => typeof tag === 'string' && prTag.exec(tag)?.[1] === String(number));
}

export class Registry {
  constructor(publisher, repo) {
    const [owner, name] = repo.full_name.toLowerCase().split('/');
    this.publisher = publisher;
    this.image = 'ghcr.io/' + repo.full_name.toLowerCase();
    this.root = `orgs/${owner}/packages/container/${name}`;
  }
  request(path, ...options) {
    const data = this.publisher.command('gh', ['api', this.root + path, ...options], { encoding: 'utf8' });
    return data.trim() ? JSON.parse(data) : null;
  }
  versions() {
    const pages = this.request('/versions?per_page=100', '--paginate', '--slurp');
    if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) throw new Error('Incomplete package inventory');
    return pages.flat();
  }
  version(id) { return this.request('/versions/' + id); }
  remove(id) { this.request('/versions/' + id, '--method', 'DELETE'); }
  manifest(digest) {
    return JSON.parse(this.publisher.command('skopeo', ['inspect', '--raw', 'docker://' + this.image + '@' + digest], { encoding: 'utf8' }));
  }
}

// A tagged multi-platform index can reference an image even when the child has only a PR tag.
function protectManifests(registry, roots) {
  const seen = new Set();
  function visit(digest) {
    if (!digestPattern.test(digest)) throw new Error('Invalid registry digest');
    if (seen.has(digest)) return;
    seen.add(digest);
    const manifest = registry.manifest(digest);
    if (manifest.schemaVersion !== 2) throw new Error('Unknown image manifest');
    if (Array.isArray(manifest.manifests)) {
      for (const descriptor of manifest.manifests) visit(descriptor.digest);
    } else if (!Array.isArray(manifest.layers) || !manifest.config) {
      throw new Error('Incomplete image manifest');
    }
  }
  for (const root of roots) visit(root);
  return seen;
}

export function cleanup(publisher, registry, number, { apply = false, log = console.log } = {}) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Expected a positive PR number');
  function isClosed() {
    const pr = publisher.api('/pulls/' + number);
    if (pr.number !== number || !['open', 'closed'].includes(pr.state)) throw new Error('Unknown PR state');
    return pr.state === 'closed';
  }
  if (!isClosed()) { log('PR is open; no cleanup'); return; }
  const files = stateFiles(publisher);
  if (files.has(number)) throw new Error('Preview state still exists; retry after reconciliation');
  const roots = new Set();
  for (const [pr, sha] of files) roots.add(readState(publisher, pr, sha).imageDigest);
  const versions = registry.versions();
  const candidates = [];
  for (const version of versions) {
    const tags = version.metadata?.container?.tags;
    if (!Number.isSafeInteger(version.id) || version.id <= 0 || !digestPattern.test(version.name) ||
        !Array.isArray(tags) || !tags.every(t => typeof t === 'string' && t.length)) throw new Error('Invalid package version');
    if (exclusive(version, number)) candidates.push(version);
    else if (tags.length) roots.add(version.name);
  }
  if (!candidates.length) { log('No exclusive PR image versions'); return; }
  const protectedDigests = protectManifests(registry, roots);
  for (const candidate of candidates) {
    if (protectedDigests.has(candidate.name)) { log('Retain referenced ' + candidate.name); continue; }
    const current = registry.version(candidate.id);
    if (current.id !== candidate.id || current.name !== candidate.name || !exclusive(current, number)) {
      log('Retain changed version ' + candidate.id);
      continue;
    }
    if (!isClosed()) { log('PR reopened; stopping cleanup'); return; }
    if (apply) registry.remove(candidate.id);
    log(`${apply ? 'Deleted' : 'Would delete'} PR #${number} version ${candidate.id} ${candidate.name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [repository, pr, flag, ...extra] = process.argv.slice(2);
  if (!/^[1-9][0-9]*$/.test(pr) || (flag && flag !== '--apply') || extra.length) {
    throw new Error('Usage: cleanup-preview-images.mjs OWNER/REPO PR [--apply]');
  }
  const publisher = new Publisher(repository);
  const repo = publisher.api('');
  if (repo.full_name.toLowerCase() !== repository.toLowerCase() || repo.owner.type !== 'Organization') {
    throw new Error('Expected the team organization repository');
  }
  const registry = new Registry(publisher, repo);
  if (registry.request('').repository?.id !== repo.id) throw new Error('Package is not linked to this repository');
  cleanup(publisher, registry, Number(pr), { apply: flag === '--apply' });
}
