import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, Registry } from '../scripts/cleanup-preview-images.mjs';

const sha = 'a'.repeat(40);
const digest = id => 'sha256:' + id.toString(16).padStart(64, '0');
const tag = (number, commit = sha) => 'pr-' + number + '-' + commit;
const version = (id, ...tags) => ({
  id, name: digest(id), metadata: { package_type: 'container', container: { tags } },
});

function fixture(versions, states = {}) {
  const stored = new Map(versions.map(item => [item.id, item]));
  const removed = [];
  const registry = {
    versions: () => [...stored.values()],
    version: id => stored.get(id),
    manifest: () => ({ schemaVersion: 2, config: {}, layers: [] }),
    remove(id) {
      assert.ok(stored.delete(id));
      removed.push(id);
    },
  };
  const publisher = { api(path) {
    if (path === '/pulls/23') return { number: 23, state: 'closed' };
    if (path.startsWith('/git/trees/')) return {
      truncated: false, tree: Object.keys(states).map(number => ({
        path: 'previews/pr-' + number + '/state.json', type: 'blob', sha: number.padStart(40, '0'),
      })),
    };
    if (path.startsWith('/git/blobs/')) {
      const number = String(Number(path.split('/').pop()));
      const state = { prNumber: number, commitSha: sha, imageDigest: states[number] };
      return { encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') };
    }
    throw Error('Unexpected API path ' + path);
  } };
  const run = (apply = true) => cleanup(publisher, registry, 23, { apply, log() {} });
  return { registry, publisher, removed, run };
}

test('deletes all exclusive commits, retains main/shared/foreign/unknown and untagged versions on retry', () => {
  const f = fixture([
    version(1, tag(23)), version(2, tag(23, 'b'.repeat(40))),
    version(3, tag(23), 'sha-' + sha), version(4, tag(23), tag(18)),
    version(5, tag(230)), version(6, tag(23), 'latest'),
    version(7), version(8, 'sha-' + sha), version(9, tag(18)),
  ]);
  f.run(false);
  assert.deepEqual(f.removed, []);
  f.run(); f.run();
  assert.deepEqual(f.removed, [1, 2]);
  assert.deepEqual(f.registry.versions().map(v => v.id), [3, 4, 5, 6, 7, 8, 9]);
});

test('retains a digest pinned by another PR even without its tag', () => {
  const f = fixture([version(1, tag(23)), version(2, tag(23))], { 18: digest(1) });
  f.run();
  assert.deepEqual(f.removed, [2]);
});

test('retains a PR-tagged child manifest of a main image index', () => {
  const f = fixture([version(1, tag(23)), version(2, 'sha-' + sha)]);
  const single = f.registry.manifest;
  f.registry.manifest = d => d === digest(2) ? { schemaVersion: 2, manifests: [{ digest: digest(1) }] } : single();
  f.run();
  assert.deepEqual(f.removed, []);
});

test('no deletion if the closing PR still has preview state or reopens during cleanup', () => {
  const active = fixture([version(1, tag(23))], { 23: digest(1) });
  assert.throws(() => active.run(), /state still exists/);
  assert.deepEqual(active.removed, []);
  const f = fixture([version(1, tag(23))]);
  const api = f.publisher.api;
  let reads = 0;
  f.publisher.api = path => path === '/pulls/23' && reads++ > 0 ? { number: 23, state: 'open' } : api(path);
  f.run();
  assert.deepEqual(f.removed, []);
});

test('retains a version that gained a main tag after listing', () => {
  const f = fixture([version(1, tag(23))]);
  f.registry.version = id => version(id, tag(23), 'sha-' + sha);
  f.run();
  assert.deepEqual(f.removed, []);
});

test('bad metadata, incomplete state or registry access error stops deletion', () => {
  for (const corrupt of [
    f => { f.registry.versions = () => [version(1, tag(23)), { id: 2, name: digest(2) }]; },
    f => { const api = f.publisher.api; f.publisher.api = p => p.includes('/trees/') ? { truncated: true } : api(p); },
    f => { f.registry.manifest = () => { throw Error('registry unavailable'); }; },
  ]) {
    const f = fixture([version(1, tag(23)), version(2, 'sha-' + sha)]);
    corrupt(f);
    assert.throws(() => f.run());
    assert.deepEqual(f.removed, []);
  }
});

test('retry finishes remaining versions after a partial deletion', () => {
  const f = fixture([version(1, tag(23)), version(2, tag(23))]);
  const remove = f.registry.remove;
  f.registry.remove = id => { if (id === 2) throw Error('temporary API failure'); remove(id); };
  assert.throws(() => f.run(), /temporary API failure/);
  f.registry.remove = remove;
  f.run();
  assert.deepEqual(f.removed, [1, 2]);
});

test('package API adapter reads all pages before deleting an old version on page two', () => {
  const { publisher } = fixture([]);
  const first = Array.from({ length: 100 }, (_, i) => version(i + 1, 'sha-' + sha));
  const old = version(101, tag(23));
  const requests = [];
  publisher.command = (tool, args) => {
    if (tool === 'skopeo') return JSON.stringify({ schemaVersion: 2, config: {}, layers: [] });
    requests.push(args);
    assert.equal(tool, 'gh');
    const root = 'orgs/asbg-preview/packages/container/preview/versions';
    if (args[1] === root + '?per_page=100') {
      assert.deepEqual(args.slice(2), ['--paginate', '--slurp']);
      return JSON.stringify([first, [old]]);
    }
    assert.equal(args[1], root + '/101');
    return args.includes('DELETE') ? '' : JSON.stringify(old);
  };
  const registry = new Registry(publisher, { full_name: 'ASBG-PReview/PReview' });
  cleanup(publisher, registry, 23, { apply: true, log() {} });
  assert.deepEqual(requests.filter(args => args.includes('DELETE')), [
    ['api', 'orgs/asbg-preview/packages/container/preview/versions/101', '--method', 'DELETE'],
  ]);
});
