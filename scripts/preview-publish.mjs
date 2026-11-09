import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recipe } from './stage-preview.mjs';

const buildPath = '.github/workflows/pr-build.yml';
const publishPath = '.github/workflows/pr-publish.yml';
const receiptName = 'preview-publication.json';
const intentName = 'preview-intent.json';
const bot = 'dependabot[bot]';
const fullSha = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const positiveId = n => Number.isSafeInteger(n) && n > 0;
const statusContext = n => 'preview/ready/pr-' + n;
const imageName = repo => 'ghcr.io/' + repo.full_name.toLowerCase();
const imageTag = (repo, pr) => imageName(repo) + ':pr-' + pr.number + '-' + pr.head.sha;

export function candidateFor({ repository, workflow_run: run }) {
  if (run.event !== 'pull_request' || run.conclusion !== 'success' || run.path !== buildPath ||
      run.head_repository?.id !== repository.id || run.actor.login === bot || run.pull_requests.length !== 1) return null;
  const [pr] = run.pull_requests;
  if (!positiveId(pr.number) || !fullSha.test(run.head_sha) || pr.head.sha !== run.head_sha ||
      pr.head.repo?.id !== repository.id || pr.base.repo?.id !== repository.id ||
      pr.base.ref !== repository.default_branch || !fullSha.test(pr.base.sha)) return null;
  return pr;
}

export function currentPR(live, pr, repo) {
  return live.state === 'open' && live.number === pr.number && live.user.login !== bot &&
    live.head.sha === pr.head.sha && live.head.repo?.id === repo.id &&
    live.base.repo?.id === repo.id && live.base.ref === repo.default_branch;
}

export function receipt(repo, pr, digest, runId, attempt) {
  if (!digestPattern.test(digest) || !positiveId(runId) || !positiveId(attempt)) {
    throw new Error('Invalid publication receipt');
  }
  // Alphabetical keys, compact JSON and one LF preserve the signed v1 wire format.
  return JSON.stringify({
    digest, head_sha: pr.head.sha, image: imageTag(repo, pr), pr: pr.number,
    repository_id: repo.id, run_attempt: attempt, run_id: runId, version: 1,
  }) + '\n';
}

export function intent(repo, pr, digest) {
  if (!digestPattern.test(digest)) throw new Error('Invalid publication intent digest');
  // This proof survives retries. Its purpose distinguishes it from the run-specific receipt.
  return JSON.stringify({
    digest, head_sha: pr.head.sha, image: imageTag(repo, pr), pr: pr.number,
    purpose: 'preview-publication-intent', repository_id: repo.id, version: 1,
  }) + '\n';
}

export class Publisher {
  constructor(repositoryName) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repositoryName)) throw new Error('Expected owner/repository');
    this.root = 'repos/' + repositoryName;
  }

  command(program, args, options = {}) {
    return execFileSync(program, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  }

  api(path, { method = 'GET', body } = {}) {
    const args = ['api', this.root + path, '--method', method];
    if (body !== undefined) args.push('--input', '-');
    const output = this.command('gh', args, { input: JSON.stringify(body), encoding: 'utf8' });
    return output.trim() ? JSON.parse(output) : null;
  }

  trustedBuilder(pr) {
    const paths = [buildPath, 'scripts/stage-preview.mjs', ...recipe.map(p => 'preview-api/' + p)];
    const rows = this.command('git', ['ls-tree', '-r', 'HEAD', '--', ...paths], { encoding: 'utf8' });
    const trusted = new Map();
    for (const row of rows.trimEnd().split('\n')) {
      const [metadata, path] = row.split('\t');
      const [mode, kind, sha] = metadata.split(' ');
      if (kind === 'blob' && ['100644', '100755'].includes(mode)) trusted.set(path, { mode, sha });
    }
    if (paths.some(path => !trusted.has(path))) throw new Error('Missing trusted build input');
    for (const { sha } of [pr.head, pr.base]) {
      const snapshot = this.api('/git/trees/' + sha + '?recursive=1');
      if (snapshot.truncated !== false) throw new Error('Cannot verify incomplete Git tree');
      const found = new Map(snapshot.tree.map(entry => [entry.path, entry]));
      if (!paths.every(path => found.get(path)?.sha === trusted.get(path).sha &&
                               found.get(path)?.mode === trusted.get(path).mode)) return false;
    }
    return true;
  }

  ensureLabel() {
    const names = this.command('gh', ['api', '--paginate', this.root + '/labels?per_page=100',
      '--jq', '.[].name'], { encoding: 'utf8' });
    if (names.split(/\r?\n/).includes('preview')) return;
    try {
      this.api('/labels', { method: 'POST', body: { name: 'preview', color: '0969da' } });
    } catch (error) {
      if (this.api('/labels/preview')?.name !== 'preview') throw error;
    }
  }

  recordAndLabel(repo, pr, digest, runId, attempt) {
    if (!digestPattern.test(digest)) throw new Error('Invalid publication digest');
    this.api('/statuses/' + pr.head.sha, { method: 'POST', body: {
      state: 'success', context: statusContext(pr.number), description: digest,
      target_url: repo.html_url + '/actions/runs/' + runId + '/attempts/' + attempt,
    } });
    this.ensureLabel();
    const path = '/pulls/' + pr.number;
    const live = this.api(path);
    if (!currentPR(live, pr, repo) || live.labels.some(label => label.name === 'preview')) return;
    const labels = '/issues/' + pr.number + '/labels';
    const updated = this.api(labels, { method: 'POST', body: { labels: ['preview'] } });
    if (!updated.some(label => label.name === 'preview')) throw new Error('Missing preview label');
    if (!currentPR(this.api(path), pr, repo)) this.api(labels + '/preview', { method: 'DELETE' });
  }

  hasSuccessfulPublication(repo, pr, digest, target) {
    const prefix = repo.html_url + '/actions/runs/';
    const match = typeof target === 'string' && target.startsWith(prefix) &&
      /^([1-9]\d*)\/attempts\/([1-9]\d*)$/.exec(target.slice(prefix.length));
    if (!match) throw new Error('Missing publisher run attempt');
    const runId = Number(match[1]);
    const attempt = Number(match[2]);
    const bytes = receipt(repo, pr, digest, runId, attempt);
    const run = this.api('/actions/runs/' + runId + '/attempts/' + attempt);
    const workflow = this.api('/actions/workflows/pr-publish.yml');
    if (run.id !== runId || run.run_attempt !== attempt || run.event !== 'workflow_run' || run.workflow_id !== workflow.id ||
        run.path !== publishPath || run.repository.id !== repo.id || run.head_repository?.id !== repo.id ||
        run.head_branch !== repo.default_branch || !fullSha.test(run.head_sha)) {
      throw new Error('Not a successful default-branch publisher attempt');
    }
    if (run.status !== 'completed' || run.conclusion !== 'success') return false;
    this.verifySignature(repo, receiptName, bytes, run.head_sha);
    return true;
  }

  verifySignature(repo, name, bytes, sourceSha) {
    const ref = 'refs/heads/' + repo.default_branch;
    const dir = mkdtempSync(join(tmpdir(), 'preview-proof-'));
    try {
      const file = join(dir, name);
      writeFileSync(file, bytes);
      const args = ['attestation', 'verify', file, '--repo', repo.full_name,
        '--cert-identity', repo.html_url + '/' + publishPath + '@' + ref, '--source-ref', ref];
      if (sourceSha) args.push('--source-digest', sourceSha);
      args.push('--deny-self-hosted-runners');
      this.command('gh', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  *readinessRecords(number, sha) {
    for (let page = 1; ; page++) {
      const rows = this.api('/commits/' + sha + '/statuses?per_page=100&page=' + page);
      yield* rows.filter(row => row.context === statusContext(number));
      if (rows.length < 100) return;
    }
  }

  resolve(number, sha) {
    if (!positiveId(number) || !fullSha.test(sha)) throw new Error('Expected PR number and full SHA');
    const repo = this.api('');
    const pr = { number, head: { sha } };
    let expectedDigest;
    for (const status of this.readinessRecords(number, sha)) {
      const digest = status.description;
      if (status.state !== 'success' || status.creator.login !== 'github-actions[bot]' ||
          !digestPattern.test(digest)) throw new Error('Invalid preview readiness record');
      if (expectedDigest && digest !== expectedDigest) throw new Error('Conflicting publication digest');
      expectedDigest = digest;
      // Only the outcome of a trusted publisher attempt can defer to an earlier record.
      if (!this.hasSuccessfulPublication(repo, pr, digest, status.target_url)) continue;
      const manifest = this.command('skopeo', ['inspect', '--raw', 'docker://' + imageTag(repo, pr)]);
      if ('sha256:' + createHash('sha256').update(manifest).digest('hex') !== digest) {
        throw new Error('Published manifest differs from the readiness record');
      }
      const live = this.api('/pulls/' + number);
      if (!currentPR(live, pr, repo) || !live.labels.some(label => label.name === 'preview')) {
        throw new Error('Not the current labeled PR head');
      }
      return imageName(repo) + '@' + digest;
    }
    if (expectedDigest) throw new Error('No successful publisher attempt for this PR and SHA');
    throw new Error('No verified publication for this PR and SHA');
  }

  handle(mode, event, env) {
    const repo = event.repository;
    const pr = candidateFor(event);
    const runId = Number(env.GITHUB_RUN_ID);
    const attempt = Number(env.GITHUB_RUN_ATTEMPT);
    if (mode === 'intent' || mode === 'verify-intent') {
      if (!pr) throw new Error('Cannot authorize an unrelated workflow run');
      const bytes = intent(repo, pr, env.PREVIEW_DIGEST);
      if (mode === 'intent') writeFileSync(join(env.RUNNER_TEMP, intentName), bytes);
      else this.verifySignature(repo, intentName, bytes);
      return;
    }
    if (mode === 'receipt') {
      if (!pr) throw new Error('Cannot sign an unrelated workflow run');
      writeFileSync(join(env.RUNNER_TEMP, receiptName), receipt(repo, pr, env.PREVIEW_DIGEST, runId, attempt));
      return;
    }
    const current = !!pr && currentPR(this.api('/pulls/' + pr.number), pr, repo);
    switch (mode) {
      case 'current':
        return String(current);
      case 'check': {
        const eligible = current && this.trustedBuilder(pr);
        let output = 'eligible=' + eligible + '\n';
        if (eligible) output += 'sha=' + pr.head.sha + '\nimage=' + imageTag(repo, pr) + '\n';
        appendFileSync(env.GITHUB_OUTPUT, output);
        return;
      }
      case 'label':
        if (current) this.recordAndLabel(repo, pr, env.PREVIEW_DIGEST, runId, attempt);
        return;
      default:
        throw new Error('Unknown mode: ' + mode);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, repository, number, sha] = process.argv.slice(2);
  if (mode === 'resolve') {
    console.log(new Publisher(repository).resolve(Number(number), sha));
  } else {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const result = new Publisher(event.repository.full_name).handle(mode, event, process.env);
    if (result !== undefined) console.log(result);
  }
}
