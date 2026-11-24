import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Publisher } from './preview-publish.mjs';
import { readState, stateFiles } from './reconcile-preview-state.mjs';

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
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

// A package version can be a retained index even when it has no tags.
function inventory(versions) {
  const rows = new Map();
  const digests = new Set();
  for (const v of versions) {
    const tags = v.metadata?.container?.tags;
    if (!Number.isSafeInteger(v.id) || v.id <= 0 || rows.has(v.id) ||
        v.metadata?.package_type !== 'container' || typeof v.name !== 'string' || !digestPattern.test(v.name) || digests.has(v.name) ||
        !Array.isArray(tags) || !tags.every(t => typeof t === 'string' && t.length)) {
      throw new Error('Invalid or ambiguous package inventory');
    }
    rows.set(v.id, JSON.stringify([v.name, [...tags].sort()]));
    digests.add(v.name);
  }
  return rows;
}

function sameInventory(a, b) {
  return a.size === b.size && [...a].every(([id, value]) => b.get(id) === value);
}

function manifestOrder(registry, roots, candidates) {
  const protectedDigests = new Set();
  const childrenFirst = [];
  const seen = new Set();
  const visiting = new Set();
  function visit(digest, protect) {
    if (typeof digest !== 'string' || !digestPattern.test(digest) || visiting.has(digest)) throw new Error('Invalid manifest graph');
    if (seen.has(digest)) return;
    visiting.add(digest);
    const manifest = registry.manifest(digest);
    if (manifest.schemaVersion !== 2) throw new Error('Unknown image manifest');
    // OCI artifacts can refer to another manifest even when they have no child index.
    if (Object.hasOwn(manifest, 'subject')) visit(manifest.subject?.digest, protect);
    if (Array.isArray(manifest.manifests)) {
      for (const descriptor of manifest.manifests) visit(descriptor.digest, protect);
    } else if (!Array.isArray(manifest.layers) || !manifest.config) {
      throw new Error('Incomplete image manifest');
    }
    visiting.delete(digest);
    seen.add(digest);
    if (protect) protectedDigests.add(digest);
    else if (candidates.has(digest)) childrenFirst.push(candidates.get(digest));
  }
  for (const digest of roots) visit(digest, true);
  // Preserve registry listing order for independent candidates. For an index,
  // remove the parent first so interruption never strands a retained parent.
  for (const digest of [...candidates.keys()].reverse()) visit(digest, false);
  return { protectedDigests, deletions: childrenFirst.reverse() };
}

function activePRRoots(publisher, number) {
  const files = stateFiles(publisher);
  if (files.has(number)) throw new Error('Preview state still exists; retry after reconciliation');
  return [...files].map(([pr, sha]) => readState(publisher, pr, sha).imageDigest);
}

export function cleanup(publisher, registry, number, {
  apply = false, log = console.log, deploymentRoots = () => activePRRoots(publisher, number),
  assertCurrent = () => {}, expectedClose,
} = {}) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Expected a positive PR number');
  function isClosed() {
    const pr = publisher.api('/pulls/' + number);
    if (pr.number !== number || !['open', 'closed'].includes(pr.state)) throw new Error('Unknown PR state');
    return pr.state === 'closed' && (expectedClose === undefined ||
      Date.parse(pr.closed_at) === Date.parse(expectedClose));
  }
  if (!isClosed()) { log('PR closure no longer matches; no cleanup'); return false; }
  const roots = new Set(deploymentRoots());
  const versions = registry.versions();
  const expected = inventory(versions);
  const candidates = new Map();
  for (const v of versions) {
    if (exclusive(v, number)) candidates.set(v.name, v);
    else roots.add(v.name);
  }
  if (!candidates.size) { assertCurrent(); log('No exclusive PR image versions'); return isClosed(); }
  const { protectedDigests, deletions } = manifestOrder(registry, roots, candidates);
  for (const digest of candidates.keys()) {
    if (protectedDigests.has(digest)) log('Retain referenced ' + digest);
  }
  for (const v of deletions) {
    // A different retained parent may have acquired a tag since the plan.
    if (!sameInventory(expected, inventory(registry.versions()))) {
      log('Package inventory changed; recompute the plan'); return false;
    }
    const current = registry.version(v.id);
    if (current.id !== v.id || current.name !== v.name || !exclusive(current, number)) {
      log('Retain changed package version ' + v.id); return false;
    }
    assertCurrent();
    if (!isClosed()) { log('PR reopened; stopping cleanup'); return false; }
    if (apply) { registry.remove(v.id); expected.delete(v.id); }
    log(`${apply ? 'Deleted' : 'Would delete'} PR #${number} version ${v.id} ${v.name}`);
  }
  assertCurrent();
  return deletions.length === candidates.size && isClosed();
}

// Pin reads to the main deployment tree, then preserve the previous distinct
// main image as a rollback target. A history/API failure blocks deletion.
export function mainImageRoots(publisher, mainRef, repository) {
  if (!isSha(mainRef)) throw new Error('Invalid main deployment revision');
  const file = 'charts/preview-api/values-main-image.json';
  const roots = new Set();
  function readAt(ref) {
    const result = publisher.api('/contents/' + file + '?ref=' + ref);
    if (result.encoding !== 'base64') throw new Error('Invalid main deployment blob');
    const values = JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
    if (values.image?.repository !== 'ghcr.io/' + repository.toLowerCase() ||
        typeof values.image.digest !== 'string' || !digestPattern.test(values.image.digest)) {
      throw new Error('Invalid main deployment image');
    }
    roots.add(values.image.digest);
  }
  readAt(mainRef);
  for (let page = 1; roots.size < 2; ++page) {
    const commits = publisher.api(`/commits?sha=${mainRef}&path=${file}&per_page=100&page=${page}`);
    if (!Array.isArray(commits)) throw new Error('Incomplete main deployment history');
    for (const commit of commits) {
      if (!isSha(commit.sha)) throw new Error('Invalid main history SHA');
      if (commit.sha !== mainRef) readAt(commit.sha);
      if (roots.size === 2) break;
    }
    if (commits.length < 100) break;
  }
  return roots;
}

async function run() {
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
  const readRef = name => {
    const sha = publisher.api('/git/ref/heads/' + name).object.sha;
    if (!isSha(sha)) throw new Error('Unknown deployment revision');
    return sha;
  };
  const main = readRef('main-deploy'), state = readRef('preview-state');
  function assertCurrent() {
    if (readRef('preview-state') !== state || readRef('main-deploy') !== main) {
      throw new Error('Deployment revision changed; retry cleanup');
    }
  }
  const { protectedStateDigests, listCleanup } = await import('./reconcile-preview-state.mjs');
  const number = Number(pr);
  const ticket = flag && listCleanup(publisher).find(item => item.prNumber === number &&
    item.ticketSha === process.env.PREVIEW_CLEANUP_TICKET);
  if (flag && (!ticket || !Number.isFinite(Date.parse(ticket.closedAt)))) {
    throw new Error('No matching cleanup ticket outside the retention window');
  }
  const complete = cleanup(publisher, registry, number, { apply: Boolean(flag), assertCurrent,
    expectedClose: flag ? ticket.closedAt : undefined,
    deploymentRoots() {
      const roots = [...activePRRoots(publisher, number), ...mainImageRoots(publisher, main, repository),
        ...protectedStateDigests(publisher)];
      assertCurrent();
      return roots;
    },
  });
  if (!complete && flag) {
    console.log('Cleanup deferred; retain the ticket for the next pass');
    process.exitCode = 75;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
