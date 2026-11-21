import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteMain } from '../scripts/promote-main.mjs';
const sha = 'a'.repeat(40);
const identity = { repository: 'ASBG-PReview/PReview', sha, digest: 'sha256:' + 'b'.repeat(64) };
function fixture({ missing = false, stale = false, advance = false, conflict = false, forbidden = false } = {}) {
  const calls = []; let reads = 0;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith('/ref/heads/main')) return { object: { sha: stale || (advance && reads++ > 0) ? 'c'.repeat(40) : sha } };
    if (path.endsWith('/ref/heads/main-deploy')) {
      if (missing || forbidden) throw Object.assign(new Error('lookup'), { status: forbidden ? 403 : 404 });
      return { object: { sha: 'previous' } };
    }
    if (method === 'GET') return { tree: { sha: 'tested-tree' } };
    if (method === 'PATCH' && conflict) throw Object.assign(new Error('conflict'), { status: 422 });
    return { sha: 'new' };
  };
  return { api, calls };
}
test('promotes digest with tested source tree and preserves deployment history', async () => {
  const f = fixture(); await promoteMain(f.api, identity);
  const tree = f.calls.find(x => x.path.endsWith('/trees')).body;
  assert.equal(tree.base_tree, 'tested-tree');
  assert.deepEqual(JSON.parse(tree.tree[0].content), { image: { repository: 'ghcr.io/asbg-preview/preview', digest: identity.digest }, main: { commitSha: sha } });
  assert.deepEqual(f.calls.find(x => x.path.endsWith('/commits') && x.method === 'POST').body.parents, ['previous']);
  assert.deepEqual(f.calls.at(-1).body, { sha: 'new', force: false });
});
test('initializes deployment branch only on 404', async () => {
  const f = fixture({ missing: true }); await promoteMain(f.api, identity);
  assert.equal(f.calls.at(-1).body.ref, 'refs/heads/main-deploy');
});
for (const mode of ['stale', 'advance', 'forbidden']) test(`does not move deployment ref on ${mode}`, async () => {
  const f = fixture({ [mode]: true }); await assert.rejects(promoteMain(f.api, identity));
  assert.ok(!f.calls.some(x => x.method === 'PATCH' || x.path.endsWith('/refs')));
});
test('does not force or retry a concurrent deployment update', async () => {
  const f = fixture({ conflict: true }); await assert.rejects(promoteMain(f.api, identity));
  assert.equal(f.calls.filter(x => x.method === 'PATCH').length, 1);
  assert.equal(f.calls.at(-1).body.force, false);
});
test('rejects unverified digest before any API request', async () => {
  const f = fixture(); await assert.rejects(promoteMain(f.api, { ...identity, digest: 'latest' })); assert.equal(f.calls.length, 0);
});
