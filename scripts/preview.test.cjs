const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectPreview, publishedLabels } = require('./preview.cjs');
const sha = 'a'.repeat(40), repository = 'ASBG-PReview/PReview';
const run = {conclusion:'success', event:'pull_request', head_repository:{full_name:repository}, head_sha:sha};
const pr = {number:12, state:'open', draft:false, base:{ref:'main',repo:{full_name:repository}}, head:{sha,repo:{full_name:repository}}};
test('current same-repository PR can publish', () => assert.equal(selectPreview(run,[pr],repository).number,12));
test('stale, closed, draft, fork and failed runs cannot publish', () => {
  for (const candidate of [{...pr,state:'closed'},{...pr,draft:true},
    {...pr,head:{...pr.head,sha:'b'.repeat(40)}}, {...pr,head:{...pr.head,repo:{full_name:'fork/repo'}}}]) {
    assert.equal(selectPreview(run,[candidate],repository),null);
  }
  assert.equal(selectPreview({...run,conclusion:'failure'},[pr],repository),null);
  assert.equal(selectPreview({...run,event:'push'},[pr],repository),null);
  assert.equal(selectPreview(run,[pr,pr],repository),null);
});
test('published revision is unique and unrelated labels survive', () => {
  assert.deepEqual(publishedLabels([{name:'bug'},{name:'preview-ready'},{name:`sha-${'b'.repeat(40)}`}],sha),
    ['bug','preview-ready',`sha-${sha}`]);
  assert.throws(() => publishedLabels([], '$(bad)'));
});
test('revision labels fit the GitHub 50-character limit without truncating SHA', () => {
  const labels = publishedLabels([],sha);
  assert.ok(labels.every(label => label.length <= 50));
  assert.equal(labels.find(label => label.startsWith('sha-')), `sha-${sha}`);
});
