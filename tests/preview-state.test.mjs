import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, reconcileWithRetry } from '../scripts/reconcile-preview-state.mjs';

const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const digest = 'sha256:' + 'c'.repeat(64);
const oldDigest = 'sha256:' + 'd'.repeat(64);
const repo = { id: 1, full_name: 'ASBG-PReview/PReview', default_branch: 'main' };
const pr = (number, state = 'open', head = sha) => ({ number, state, user: { login: 'member' },
  head: { sha: head, repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } }, labels: [{ name: 'preview' }] });
const old = number => ({ prNumber: String(number), commitSha: nextSha, imageDigest: oldDigest });

function fake({ open = [pr(17)], states = {}, live = {}, resolveError = false, truncated = false, failList = false, onWrite } = {}) {
  const writes = [];
  const blobs = new Map();
  const tree = Object.entries(states).map(([number, value], index) => {
    const hash = String(index + 1).padStart(40, '0');
    blobs.set(hash, value);
    return { path: `previews/pr-${number}/state.json`, type: 'blob', sha: hash };
  });
  const calls = new Map();
  return { writes, api(path, options = {}) {
    if (!path) return repo;
    if (path.startsWith('/git/trees/')) return { truncated, tree };
    if (path.startsWith('/git/blobs/')) return { encoding: 'base64', content: Buffer.from(JSON.stringify(blobs.get(path.split('/').at(-1)))).toString('base64') };
    if (path.startsWith('/pulls?')) {
      if (failList) throw new Error('API unavailable');
      return open;
    }
    const match = /^\/pulls\/(\d+)$/.exec(path);
    if (match) {
      const number = Number(match[1]);
      const index = calls.get(number) || 0;
      calls.set(number, index + 1);
      const value = live[number] || open.find(x => x.number === number) || pr(number, 'closed');
      return Array.isArray(value) ? value[Math.min(index, value.length - 1)] : value;
    }
    if (path.startsWith('/contents/')) {
      writes.push({ path, ...options });
      if (onWrite) onWrite(path, options);
      return {};
    }
    throw new Error(`Unexpected API ${path}`);
  }, resolve(number, head) {
    if (resolveError) throw new Error('image pending');
    assert.equal(head, sha);
    return `ghcr.io/asbg-preview/preview@${digest}`;
  } };
}
const quiet = () => {};
const payload = write => JSON.parse(Buffer.from(write.body.content, 'base64').toString());

test('writes separate verified state for two PRs', () => {
  const p = fake({ open: [pr(17), pr(18)] });
  assert.equal(reconcile(p, quiet), 0);
  assert.deepEqual(p.writes.map(x => x.path), ['/contents/previews/pr-17/state.json', '/contents/previews/pr-18/state.json']);
  assert.deepEqual(payload(p.writes[0]), { prNumber: '17', commitSha: sha, imageDigest: digest });
});
test('admits at most two previews and keeps later PRs waiting', () => {
  const p = fake({ open: [pr(19), pr(17), pr(18)] });
  assert.equal(reconcile(p, quiet), 0);
  assert.deepEqual(p.writes.map(x => payload(x).prNumber), ['17', '18']);
});
test('keeps existing previews instead of evicting them for an older waiting PR', () => {
  const p = fake({ open: [pr(16), pr(17), pr(18)], states: { 17: old(17), 18: old(18) } });
  assert.equal(reconcile(p, quiet), 0);
  assert.deepEqual(p.writes.map(x => payload(x).prNumber), ['17', '18']);
});
test('frees a closed slot before admitting the lowest-numbered waiting PR', () => {
  const p = fake({ open: [pr(10), pr(18), pr(19)], states: { 17: old(17), 18: old(18) } });
  assert.equal(reconcile(p, quiet), 0);
  assert.deepEqual(p.writes.map(x => [x.method, x.path]), [
    ['DELETE', '/contents/previews/pr-17/state.json'],
    ['PUT', '/contents/previews/pr-18/state.json'],
    ['PUT', '/contents/previews/pr-10/state.json'],
  ]);
});
test('does not admit a waiting PR when a closed PR reopens during deletion', () => {
  const p = fake({ open: [pr(18), pr(19)], states: { 17: old(17), 18: old(18) },
    live: { 17: [pr(17, 'closed'), pr(17, 'closed'), pr(17)] } });
  assert.equal(reconcile(p, quiet), 0);
  assert.equal(p.writes.some(x => x.path.includes('/pr-19/')), false);
});
test('does not evict or add previews when existing slots already exceed the limit', () => {
  const p = fake({ open: [pr(17), pr(18), pr(19), pr(20)], states: { 17: old(17), 18: old(18), 19: old(19) } });
  assert.equal(reconcile(p, quiet), 0);
  assert.deepEqual(p.writes.map(x => payload(x).prNumber), ['17', '18', '19']);
});
test('preserves prior deployment when new image is not verified', () => {
  const p = fake({ states: { 17: old(17) }, resolveError: true });
  assert.equal(reconcile(p, quiet), 1);
  assert.equal(p.writes.length, 0);
});
test('does not write when PR head changes during verification', () => {
  const p = fake({ live: { 17: [pr(17), pr(17, 'open', nextSha)] } });
  assert.equal(reconcile(p, quiet), 0);
  assert.equal(p.writes.length, 0);
});
test('leaves an existing preview while an open PR has no preview label', () => {
  const unlabelled = { ...pr(17), labels: [] };
  const p = fake({ open: [unlabelled], states: { 17: old(17) } });
  assert.equal(reconcile(p, quiet), 0);
  assert.equal(p.writes.length, 0);
});
test('deletes only confirmed closed PR and leaves open PR on failed verification', () => {
  const p = fake({ open: [pr(18)], states: { 17: old(17), 18: old(18) }, resolveError: true });
  assert.equal(reconcile(p, quiet), 1);
  assert.deepEqual(p.writes.map(x => [x.method, x.path]), [['DELETE', '/contents/previews/pr-17/state.json']]);
});
test('restores previous state if PR reopens during deletion', () => {
  const p = fake({ open: [], states: { 17: old(17) }, live: { 17: [pr(17, 'closed'), pr(17, 'closed'), pr(17)] } });
  reconcile(p, quiet);
  assert.deepEqual(p.writes.map(x => x.method), ['DELETE', 'PUT']);
  assert.deepEqual(payload(p.writes[1]), old(17));
});
test('does not delete if PR reopens before the delete', () => {
  const p = fake({ open: [], states: { 17: old(17) }, live: { 17: [pr(17, 'closed'), pr(17)] } });
  assert.equal(reconcile(p, quiet), 0);
  assert.equal(p.writes.length, 0);
});
for (const options of [{ truncated: true }, { failList: true }]) {
  test('never writes when snapshot is unavailable: ' + JSON.stringify(options), () => {
    const p = fake({ states: { 17: old(17) }, ...options });
    assert.throws(() => reconcile(p, quiet));
    assert.equal(p.writes.length, 0);
  });
}
test('unchanged verified state does not produce a commit', () => {
  const p = fake({ states: { 17: { prNumber: '17', commitSha: sha, imageDigest: digest } } });
  assert.equal(reconcile(p, quiet), 0);
  assert.equal(p.writes.length, 0);
});
test('Git write conflict stops the run for a later retry', () => {
  const p = fake({ states: { 17: old(17) }, onWrite() { throw new Error('409 conflict'); } });
  assert.throws(() => reconcile(p, quiet), /409 conflict/);
});
test('retry starts again from a fresh tree after a conflict', async () => {
  let count = 0;
  const p = fake({ states: { 17: old(17) }, onWrite() { if (++count === 1) throw new Error('409 conflict'); } });
  assert.equal(await reconcileWithRetry(p, { log: quiet, sleep: async () => {} }), 0);
  assert.equal(count, 2);
});
test('reports a PR head change observed immediately after a write', () => {
  const p = fake({ live: { 17: [pr(17), pr(17), pr(17, 'open', nextSha)] } });
  assert.equal(reconcile(p, quiet), 1);
  assert.equal(p.writes.length, 1);
});
