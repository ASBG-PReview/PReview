import test from 'node:test';
import assert from 'node:assert/strict';
import { application, reconcile } from '../scripts/sync-local-previews.mjs';
const sha = 'a'.repeat(40);
const repo = { id: 1, full_name: 'example/preview', html_url: 'https://github.com/example/preview', default_branch: 'main' };
const image = 'ghcr.io/example/preview@sha256:' + 'b'.repeat(64);
const pr = { number: 12, state: 'open', user: { login: 'dev' }, labels: [{ name: 'preview' }], head: { sha, repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } } };
function fixture(options = {}) {
  const writes = [];
  return { writes, log() {}, publisher: {
    api(path) {
      if (!path) return repo;
      if (path.startsWith('/commits/')) return { sha };
      if (path.startsWith('/contents/')) return {};
      if (path.startsWith('/pulls?')) { if (options.outage) throw new Error('offline'); return options.closed ? [] : [pr]; }
      if (path === '/pulls/12') return pr;
      throw new Error(path);
    },
    resolve() { if (options.unsigned) throw new Error('unsigned'); return image; },
    command() { return JSON.stringify({ os: 'linux', architecture: options.wrongArch ? 'amd64' : 'arm64' }); },
  }, kubectl(args, input) {
    if (args.includes('applications')) return JSON.stringify({ items: [application(repo, sha, pr, image)] });
    if (args.includes('nodes')) return JSON.stringify({ items: [{ status: { nodeInfo: { architecture: 'arm64' } } }] });
    writes.push({ args, input }); return '';
  } };
}
test('trusted chart and verified image are pinned', () => {
  const app = application(repo, sha, pr, image);
  assert.equal(app.spec.source.targetRevision, sha);
  assert.equal(app.spec.source.helm.valuesObject.image.digest, image.split('@')[1]);
  assert.throws(() => application(repo, sha, pr, 'ghcr.io/other/image@sha256:' + 'b'.repeat(64)));
});
test('verified matching architecture is applied', () => {
  const f = fixture(); assert.equal(reconcile(repo.full_name, f), 0); assert.equal(f.writes[0].args[0], 'apply');
});
for (const option of ['unsigned', 'wrongArch']) test(`${option} preserves existing deployment`, () => {
  const f = fixture({ [option]: true }); assert.equal(reconcile(repo.full_name, f), 1); assert.equal(f.writes.length, 0);
});
test('closed PR cleans up application', () => {
  const f = fixture({ closed: true }); reconcile(repo.full_name, f); assert.ok(f.writes[0].args.includes('delete'));
});
test('GitHub outage never triggers deletion', () => {
  const f = fixture({ outage: true }); assert.throws(() => reconcile(repo.full_name, f)); assert.equal(f.writes.length, 0);
});
