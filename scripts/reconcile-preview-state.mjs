import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Publisher, currentPR } from './preview-publish.mjs';

const branch = 'preview-state';
const pathFor = number => `previews/pr-${number}/state.json`;
const statePath = /^previews\/pr-([1-9][0-9]*)\/state\.json$/;
const fullSha = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

// Collect complete snapshots before changing anything. A failed or truncated
// listing must never be interpreted as evidence that a PR has closed.
export function stateFiles(publisher) {
  const tree = publisher.api(`/git/trees/${branch}?recursive=1`);
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error('Incomplete state tree');
  const files = new Map();
  for (const entry of tree.tree) {
    const match = statePath.exec(entry.path);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || entry.type !== 'blob' || !fullSha.test(entry.sha)) {
      throw new Error(`Invalid state entry: ${entry.path}`);
    }
    files.set(number, entry.sha);
  }
  return files;
}

export function readState(publisher, number, fileSha) {
  const blob = publisher.api(`/git/blobs/${fileSha}`);
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`Invalid state blob: ${number}`);
  const state = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
  if (state.prNumber !== String(number) || !fullSha.test(state.commitSha) || !digestPattern.test(state.imageDigest)) {
    throw new Error(`Invalid state content: ${number}`);
  }
  return state;
}

export function snapshot(publisher) {
  const repo = publisher.api('');
  const files = stateFiles(publisher);
  const open = new Map();
  for (let page = 1; ; page++) {
    const rows = publisher.api(`/pulls?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error('Incomplete PR list');
    for (const pr of rows) {
      if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || open.has(pr.number)) throw new Error('Invalid PR list');
      open.set(pr.number, pr);
    }
    if (rows.length < 100) break;
  }
  return { repo, files, open };
}

const isEligible = (live, repo) => currentPR(live, live, repo) && live.labels?.some(label => label.name === 'preview');
const sameState = (a, b) => a?.prNumber === b.prNumber && a?.commitSha === b.commitSha && a?.imageDigest === b.imageDigest;

export function reconcile(publisher, log = console.log) {
  const { repo, files, open } = snapshot(publisher);
  const numbers = [...new Set([...open.keys(), ...files.keys()])].sort((a, b) => a - b);
  let failures = 0;
  for (const number of numbers) {
    const fileSha = files.get(number);
    const filePath = pathFor(number);
    const previous = fileSha ? readState(publisher, number, fileSha) : undefined;
    let live = publisher.api(`/pulls/${number}`);
    if (live.number !== number || !['open', 'closed'].includes(live.state)) throw new Error(`Invalid PR state: ${number}`);
    if (live.state === 'closed') {
      if (!fileSha) continue;
      // Confirm immediately before deleting; unknown or unavailable state is never deletion evidence.
      live = publisher.api(`/pulls/${number}`);
      if (live.number !== number || live.state !== 'closed') continue;
      publisher.api(`/contents/${filePath}`, { method: 'DELETE', body: {
        message: `Remove preview state for PR #${number}`, sha: fileSha, branch,
      } });
      // Git and PR state have no shared transaction. Restore the last verified
      // state if the PR was reopened during the delete; a later pass updates it.
      live = publisher.api(`/pulls/${number}`);
      if (live.number !== number || !['open', 'closed'].includes(live.state)) throw new Error(`Invalid PR state after delete: ${number}`);
      if (live.state === 'open') {
        publisher.api(`/contents/${filePath}`, { method: 'PUT', body: {
          message: `Restore preview state for reopened PR #${number}`, branch,
          content: Buffer.from(JSON.stringify(previous, null, 2) + '\n').toString('base64'),
        } });
        log(`PR #${number} reopened; restored prior state`);
      } else log(`Removed PR #${number}`);
      continue;
    }
    if (!isEligible(live, repo)) continue; // Keep an existing preview while open.
    const sha = live.head.sha;
    if (!fullSha.test(sha)) throw new Error(`Invalid head SHA: ${number}`);
    let image;
    try {
      image = publisher.resolve(number, sha);
    } catch (error) {
      failures++;
      log(`Waiting for verified PR #${number}: ${error.message}`);
      continue;
    }
    const prefix = `ghcr.io/${repo.full_name.toLowerCase()}@`;
    if (!image.startsWith(prefix) || !digestPattern.test(image.slice(prefix.length))) throw new Error('Unexpected verified image');
    const next = { prNumber: String(number), commitSha: sha, imageDigest: image.slice(prefix.length) };
    live = publisher.api(`/pulls/${number}`);
    if (!isEligible(live, repo) || live.head.sha !== sha) continue;
    if (sameState(previous, next)) continue;
    const body = { message: `Update preview state for PR #${number}`, branch,
      content: Buffer.from(JSON.stringify(next, null, 2) + '\n').toString('base64') };
    if (fileSha) body.sha = fileSha;
    publisher.api(`/contents/${filePath}`, { method: 'PUT', body });
    log(`Updated PR #${number} at ${sha}`);
    live = publisher.api(`/pulls/${number}`);
    if (!isEligible(live, repo) || live.head.sha !== sha) {
      // A follow-up reconciliation is required; do not claim convergence.
      failures++;
      log(`PR #${number} changed during update; retry required`);
    }
  }
  return failures;
}

// File SHA conflicts, transient API errors and partial prior passes all restart
// from a fresh tree and fresh PR state. A pending image remains untouched.
export async function reconcileWithRetry(publisher, { log = console.log, sleep = ms => new Promise(r => setTimeout(r, ms)), attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return reconcile(publisher, log);
    } catch (error) {
      if (attempt >= attempts) throw error;
      log(`Reconciliation error; refreshing state before retry ${attempt + 1}: ${error.message}`);
      await sleep(2000 * attempt);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repository = process.argv[2];
  if (!repository) throw new Error('Usage: node scripts/reconcile-preview-state.mjs OWNER/REPO');
  if (await reconcileWithRetry(new Publisher(repository))) process.exitCode = 1;
}
