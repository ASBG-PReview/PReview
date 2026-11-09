import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Publisher, candidateFor, currentPR, receipt } from '../scripts/preview-publish.mjs';
import { recipe } from '../scripts/stage-preview.mjs';

const sha = 'abc01234'.repeat(5);
const digestOf = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const digest = digestOf('manifest');
const image = 'ghcr.io/asbg-preview/preview';
const tag = image + ':pr-17-' + sha;
const buildPath = '.github/workflows/pr-build.yml';
const publishPath = '.github/workflows/pr-publish.yml';
const repo = { id: 4, default_branch: 'main', full_name: 'ASBG-PReview/PReview',
  html_url: 'https://github.com/ASBG-PReview/PReview' };
const publisher = () => new Publisher(repo.full_name);

function event() {
  const pr = { number: 17, head: { sha, repo: { id: 4 } },
    base: { sha: 'f'.repeat(40), ref: 'main', repo: { id: 4 } } };
  return { repository: repo, workflow_run: { event: 'pull_request', conclusion: 'success',
    path: buildPath, head_repository: repo, head_sha: sha, actor: { login: 'author' }, pull_requests: [pr] } };
}

function livePR() {
  return { ...candidateFor(event()), state: 'open', user: { login: 'author' }, labels: [{ name: 'preview' }] };
}

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'preview-test-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

// Independent v1 fixture: a receipt signed by the previous publisher must verify byte-for-byte.
const signed = Buffer.from('{"digest":"' + digest + '","head_sha":"' + sha + '","image":"' + tag +
  '","pr":17,"repository_id":4,"run_attempt":2,"run_id":42,"version":1}\n');

test('image tag includes repository, PR number and complete head SHA', () => {
  assert.equal(JSON.parse(receipt(repo, candidateFor(event()), digest, 42, 2)).image, tag);
});

for (const [field, value] of [
  ['conclusion', 'failure'], ['event', 'push'], ['path', '.github/workflows/lookalike.yml'],
  ['head_repository', { id: 99 }], ['head_repository', null], ['head_sha', 'x'.repeat(40)],
  ['head_sha', 'd'.repeat(40)], ['actor', { login: 'dependabot[bot]' }], ['pull_requests', []],
]) {
  test('refuse unrelated run: ' + field + ' ' + JSON.stringify(value), () => {
    const payload = event();
    payload.workflow_run[field] = value;
    assert.equal(candidateFor(payload), null);
  });
}

test('refuse ambiguous PR association', () => {
  const payload = event();
  payload.workflow_run.pull_requests.push(candidateFor(payload));
  assert.equal(candidateFor(payload), null);
});

for (const side of ['head', 'base']) {
  for (const change of ['missing', 'modified', 'mode', 'intact', 'truncated', '403']) {
    test('trusted build inputs: ' + side + ' ' + change, () => {
      const pub = publisher();
      const pr = candidateFor(event());
      const paths = [buildPath, 'scripts/stage-preview.mjs', ...recipe.map(p => 'preview-api/' + p)];
      pub.command = (name, args) => {
        assert.equal(name, 'git');
        assert.deepEqual(args.slice(0, 4), ['ls-tree', '-r', 'HEAD', '--']);
        assert.deepEqual(args.slice(4).sort(), [...paths].sort());
        return paths.map(p => '100644 blob abc\t' + p + '\n').join('');
      };
      pub.api = path => {
        assert.ok([pr.head, pr.base].some(ref => path === '/git/trees/' + ref.sha + '?recursive=1'));
        const tree = paths.map(path => ({ path, mode: '100644', sha: 'abc' }));
        if (path.includes(pr[side].sha)) {
          const index = tree.findIndex(file => file.path === 'preview-api/Dockerfile');
          if (change === 'missing') tree.splice(index, 1);
          if (change === 'modified') tree[index].sha = 'changed';
          if (change === 'mode') tree[index].mode = '120000';
          if (change === 'truncated') return { tree, truncated: true };
          if (change === '403') throw new Error('403');
        }
        return { tree, truncated: false };
      };
      if (change === '403' || change === 'truncated') {
        assert.throws(() => pub.trustedBuilder(pr), change === '403' ? /403/ : /incomplete/);
      } else {
        assert.equal(pub.trustedBuilder(pr), change === 'intact');
      }
    });
  }
}

for (const trusted of [false, true]) {
  test('gate exposes a publication target only for a trusted build: ' + trusted, t => {
    const pub = publisher();
    pub.api = () => livePR();
    pub.trustedBuilder = () => trusted;
    const output = join(temp(t), 'output');
    pub.handle('check', event(), { GITHUB_OUTPUT: output });
    assert.equal(readFileSync(output, 'utf8'), trusted ? 'eligible=true\nsha=' + sha + '\nimage=' + tag + '\n'
      : 'eligible=false\n');
  });
}

for (const [condition, change] of [
  ['closed', { state: 'closed' }], ['new SHA', { head: { sha: 'd'.repeat(40), repo: { id: 4 } } }],
  ['fork', { head: { sha, repo: { id: 99 } } }], ['bot', { user: { login: 'dependabot[bot]' } }],
  ['other base', { base: { ref: 'other', repo: { id: 4 } } }],
]) {
  test('delayed run refuses ' + condition, () => {
    assert.equal(currentPR({ ...livePR(), ...change }, candidateFor(event()), repo), false);
  });
}

for (const race of ['before', 'during', 'already labeled', 'stable']) {
  test('label race: ' + race, () => {
    const live = livePR();
    if (race !== 'already labeled') live.labels = [{ name: 'bug' }];
    const stale = { ...live, head: { sha: 'd'.repeat(40), repo: { id: 4 } } };
    const results = [null, race === 'before' ? stale : live, [{ name: 'preview' }], race === 'during' ? stale : live, null];
    const calls = [];
    const pub = publisher();
    pub.api = (path, options) => { calls.push([path, options]); return results.shift(); };
    pub.ensureLabel = () => {};
    pub.recordAndLabel(repo, candidateFor(event()), digest, 42, 1);
    assert.deepEqual(calls[0], ['/statuses/' + sha, { method: 'POST', body: {
      state: 'success', context: 'preview/ready/pr-17', description: digest,
      target_url: repo.html_url + '/actions/runs/42/attempts/1',
    } }]);
    assert.equal(calls[1][0], '/pulls/17');
    if (race === 'stable' || race === 'during') {
      assert.deepEqual(calls[2], ['/issues/17/labels', { method: 'POST', body: { labels: ['preview'] } }]);
      assert.equal(calls[3][0], '/pulls/17');
      assert.equal(calls.length, race === 'during' ? 5 : 4);
      if (race === 'during') assert.deepEqual(calls[4], ['/issues/17/labels/preview', { method: 'DELETE' }]);
    } else assert.equal(calls.length, 2);
  });
}

for (const [scenario, error] of [
  ['ready', null], ['new head', /No verified publication/], ['stale', /current labeled/],
  ['unlabeled', /current labeled/], ['other PR', /No verified publication/],
  ['bad digest', /readiness record/], ['registry changed', /manifest differs/],
  ['untrusted writer', /readiness record/], ['failed', /readiness record/],
  ['unrelated workflow', /publisher attempt/], ['wrong publisher branch', /publisher attempt/],
  ['wrong attempt', /publisher attempt/], ['unfinished publisher', /publisher attempt/],
  ['failed publisher', /publisher attempt/], ['missing target', /Missing publisher/],
  ['other repository', /publisher attempt/], ['unsigned receipt', /signature rejected/],
  ['replayed proof for another digest', /signature rejected/],
]) {
  test('resolve: ' + scenario, () => {
    const pub = publisher();
    const requested = ['stale', 'new head'].includes(scenario) ? 'b'.repeat(40) : sha;
    const live = livePR();
    if (scenario === 'new head') live.head.sha = requested;
    if (scenario === 'unlabeled') live.labels = [];
    const replay = scenario === 'replayed proof for another digest';
    const row = { context: 'preview/ready/pr-' + (scenario === 'other PR' ? 18 : 17),
      state: scenario === 'failed' ? 'failure' : 'success',
      creator: { login: scenario === 'untrusted writer' ? 'other' : 'github-actions[bot]' },
      target_url: scenario === 'missing target' ? null : repo.html_url + '/actions/runs/42/attempts/2',
      description: scenario === 'bad digest' ? 'bad' : (replay ? digestOf('forged manifest') : digest) };
    const run = { id: 42, run_attempt: scenario === 'wrong attempt' ? 1 : 2,
      status: scenario === 'unfinished publisher' ? 'in_progress' : 'completed',
      conclusion: scenario === 'failed publisher' ? 'failure' : 'success', event: 'workflow_run',
      workflow_id: 77, path: scenario === 'unrelated workflow' ? buildPath : publishPath, repository: repo,
      head_repository: scenario === 'other repository' ? { id: 123 } : repo,
      head_branch: scenario === 'wrong publisher branch' ? 'topic' : 'main', head_sha: 'c'.repeat(40) };
    const responses = new Map([
      ['', repo], ['/commits/' + requested + '/statuses?per_page=100&page=1', scenario === 'new head' ? [] : [row]],
      ['/actions/runs/42/attempts/2', run], ['/actions/workflows/pr-publish.yml', { id: 77 }], ['/pulls/17', live],
    ]);
    pub.api = path => { assert.ok(responses.has(path), path); return responses.get(path); };
    let verified = false;
    pub.command = (tool, args) => {
      if (tool === 'gh') {
        assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
        assert.deepEqual(args.slice(3), ['--repo', repo.full_name, '--cert-identity',
          repo.html_url + '/' + publishPath + '@refs/heads/main', '--source-ref', 'refs/heads/main',
          '--source-digest', run.head_sha, '--deny-self-hosted-runners']);
        const bytes = readFileSync(args[2]);
        // For a stale request, exercise the live head guard after valid attestation and digest.
        const expected = Buffer.from(signed.toString().replaceAll(sha, requested));
        if (scenario === 'unsigned receipt' || !bytes.equals(expected)) throw new Error('signature rejected');
        verified = true;
        return;
      }
      assert.equal(tool, 'skopeo');
      assert.equal(verified, true);
      assert.deepEqual(args, ['inspect', '--raw', 'docker://' + tag.replace(sha, requested)]);
      return Buffer.from(scenario === 'registry changed' ? 'different' : (replay ? 'forged manifest' : 'manifest'));
    };
    if (error) assert.throws(() => pub.resolve(17, requested), error);
    else assert.equal(pub.resolve(17, requested), image + '@' + digest);
  });
}

const script = name => fileURLToPath(new URL('../scripts/' + name, import.meta.url));

test('receipt CLI writes the exact signed v1 bytes', t => {
  const dir = temp(t);
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(event()));
  execFileSync(process.execPath, [script('preview-publish.mjs'), 'receipt'], { env: {
    ...process.env, GITHUB_EVENT_PATH: path, RUNNER_TEMP: dir, PREVIEW_DIGEST: digest,
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
  } });
  assert.deepEqual(readFileSync(join(dir, 'preview-publication.json')), signed);
});

for (const scenario of ['old image', 'skip tests', 'dockerignore', 'compose', 'clean']) {
  test('stage committed Docker inputs: ' + scenario, t => {
    const dir = temp(t);
    const app = join(dir, 'preview-api');
    const testFile = 'src/test/java/BrokenTest.java';
    function put(name, text) {
      const path = join(app, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    for (const name of [...recipe, testFile]) put(name, 'original');
    git('add', 'preview-api');
    git('commit', '-qm', 'fixture base');
    const base = git('rev-parse', 'HEAD').trim();
    put(testFile, 'throw new AssertionError();');
    if (scenario === 'old image') put('Dockerfile', 'FROM old-app');
    if (scenario === 'skip tests') put('build.gradle', 'test.enabled = false');
    if (scenario === 'dockerignore') put('.dockerignore', 'src/test');
    if (scenario === 'compose') put('compose.yaml', 'services: {dev: {image: old-app}}');
    git('add', 'preview-api');
    git('commit', '-qm', 'fixture head');
    put(testFile, 'uncommitted');
    const context = join(dir, 'context');
    const stage = () => execFileSync(process.execPath, [script('stage-preview.mjs'), base, context],
      { cwd: dir, stdio: 'pipe' });
    if (['clean', 'compose'].includes(scenario)) {
      stage();
      assert.equal(readFileSync(join(context, testFile), 'utf8'), 'throw new AssertionError();');
      assert.equal(existsSync(join(context, 'compose.yaml')), false);
    } else assert.throws(stage, scenario === 'dockerignore' ? /Unreviewed build input/ : /recipe differs/);
  });
}

test('concurrent label creation confirms the existing label', () => {
  const pub = publisher();
  pub.command = () => 'bug\n';
  const calls = [];
  pub.api = (path, options) => {
    calls.push([path, options]);
    if (options?.method === 'POST') throw new Error('already exists');
    return { name: 'preview' };
  };
  pub.ensureLabel();
  assert.deepEqual(calls, [['/labels', { method: 'POST', body: { name: 'preview', color: '0969da' } }],
    ['/labels/preview', undefined]]);
});
