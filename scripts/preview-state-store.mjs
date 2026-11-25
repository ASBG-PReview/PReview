import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const stateBranch = 'preview-state';
export const legacyChart = '55d093d0e6cd705e216de4efd2b4a216e7330644';
// The audit verified both external routes at snapshot 7a1fc97. Other v1
// records need a fresh verified image and the chart from the trusted checkout.
const knownLegacyImages = new Map([
  ['36', ['8ab731a4d08936b20c53383b7176196d3253a137', 'sha256:62e5296a302280a8ab04fcb633f3b145ec2549101fbcab398ed4b0d9d9aad8f5']],
  ['37', ['abeb8733eba28bd12a5ed22869e5e86bf60725c6', 'sha256:1acfe96eea05cb90ca79861be5d104c188aa3544f4b989308577350f732c888d']],
]);
export function pinnedState(value) {
  if (!value || value.chartRevision) return value;
  const identity = knownLegacyImages.get(value.prNumber);
  if (identity?.[0] === value.commitSha && identity[1] === value.imageDigest) return { ...value, chartRevision: legacyChart };
  return value;
}
export const graceMs = 24 * 60 * 60 * 1000;
export const slotPath = n => `previews/pr-${n}/state.json`;
export const projectionPath = n => `deployments/pr-${n}/state.json`;
export const ticketPath = n => `cleanup/pr-${n}.json`;
export const pendingPath = n => `control/retiring-pr-${n}.json`;
export const cursorPath = 'control/closed-sweep.json';
const safeNumber = n => Number.isSafeInteger(n) && n > 0;
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const isDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

export class InvalidState extends Error { }
export function checkedState(value, number, requireChart = false) {
  if (!safeNumber(number) || value?.prNumber !== String(number) || !isSha(value.commitSha) ||
    !isDigest(value.imageDigest) || ((requireChart || Object.hasOwn(value, 'chartRevision')) && !isSha(value.chartRevision)) ||
    Object.keys(value).some(key => !['prNumber', 'commitSha', 'imageDigest', 'chartRevision'].includes(key))) {
    throw new InvalidState('Invalid preview state for PR #' + number);
  }
  const { prNumber, commitSha, imageDigest, chartRevision } = value;
  return chartRevision === undefined ? { prNumber, commitSha, imageDigest } : { prNumber, commitSha, imageDigest, chartRevision };
}

export function isTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
}
export function checkedTicket(value, number, pending = false) {
  if (value?.prNumber !== String(number) || !isTimestamp(value.closedAt) ||
    (pending ? value.retiredAt !== null || value.previous == null : !isTimestamp(value.retiredAt)) ||
    !['closed', 'retargeted'].includes(value.reason) || !Object.hasOwn(value, 'previous')) {
    throw new Error('Invalid cleanup ticket for PR #' + number);
  }
  if (value.previous !== null) checkedState(value.previous, number);
  return value;
}
export function inGrace(ticket, now) {
  // A previous closure may be discovered much later during an outage. Give
  // Argo the full grace period after the desired state was actually removed.
  return ticket.retiredAt === null || now < Math.max(Date.parse(ticket.closedAt), Date.parse(ticket.retiredAt)) + graceMs;
}
export function readBlob(publisher, sha) {
  const result = publisher.api('/git/blobs/' + sha);
  if (result.encoding !== 'base64' || result.truncated || typeof result.content !== 'string') throw new Error('Incomplete state blob');
  return JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
}
function blobId(content) {
  return createHash('sha1').update('blob ' + Buffer.byteLength(content) + '\0').update(content).digest('hex');
}

export function inventory(publisher, revision = stateBranch) {
  const result = publisher.api('/git/trees/' + revision + '?recursive=1');
  if (result.truncated !== false || !Array.isArray(result.tree)) throw new Error('Incomplete state tree');
  const files = new Map(), slots = new Set(), projections = new Set(), tickets = new Set(), pending = new Set(), unknown = [], unsafe = new Set();
  for (const entry of result.tree) {
    if (typeof entry.path !== 'string') throw new Error('Invalid state tree path');
    if (!/^(?:previews|deployments|cleanup|control)\//.test(entry.path)) continue;
    const match = /^(previews|deployments)\/pr-([1-9][0-9]*)\/state\.json$/.exec(entry.path);
    const ticket = /^cleanup\/pr-([1-9][0-9]*)\.json$/.exec(entry.path);
    const marker = /^control\/retiring-pr-([1-9][0-9]*)\.json$/.exec(entry.path);
    if (!match && !ticket && !marker && entry.path !== cursorPath) {
      if (/^(?:previews|deployments)\/.*\/state\.json$/.test(entry.path)) unknown.push(entry.path);
      continue;
    }
    if (!isSha(entry.sha) || files.has(entry.path)) throw new Error('Invalid state entry: ' + entry.path);
    if (entry.type !== 'blob' || (entry.mode && !['100644', '100755'].includes(entry.mode))) {
      unsafe.add(entry.path);
      unknown.push(entry.path);
    }
    files.set(entry.path, entry.sha);
    if (match || ticket || marker) {
      const number = Number(match ? match[2] : (ticket || marker)[1]);
      if (!safeNumber(number)) { unknown.push(entry.path); continue; }
      (marker ? pending : ticket ? tickets : match[1] === 'previews' ? slots : projections).add(number);
    }
  }
  for (const n of pending) {
    if (!tickets.has(n) || slots.has(n) || projections.has(n)) {
      unsafe.add(pendingPath(n));
      unknown.push(pendingPath(n));
    }
  }
  return { files, slots, projections, tickets, pending, unknown, unsafe };
}

// A fast-forward ref update publishes all file changes together. If a competing
// writer wins (or a response is lost), retry against a fresh immutable tree.
export class StateStore {
  constructor(publisher) {
    this.publisher = publisher;
    this.head = publisher.api('/git/ref/heads/' + stateBranch).object.sha;
    if (!isSha(this.head)) throw new Error('Invalid state ref');
    this.tree = publisher.api('/git/commits/' + this.head).tree.sha;
    if (!isSha(this.tree)) throw new Error('Invalid state tree identity');
    Object.assign(this, inventory(publisher, this.tree));
    this.cache = new Map();
  }
  read(path) {
    if (this.unsafe.has(path)) throw new InvalidState('Unsafe Git entry: ' + path);
    const sha = this.files.get(path);
    if (!sha) return undefined;
    if (!this.cache.has(sha)) this.cache.set(sha, readBlob(this.publisher, sha));
    return this.cache.get(sha);
  }
  lastProjection(n) {
    // A deleted projection ends the previous deployment's history. Never
    // resurrect an older incarnation of a subsequently reopened preview.
    const path = projectionPath(n);
    const seen = new Set();
    for (let page = 1; ; page++) {
      const history = this.publisher.api('/commits?sha=' + this.head + '&path=' + path + '&per_page=100&page=' + page);
      if (!Array.isArray(history)) throw new Error('Incomplete projection history');
      for (const entry of history) {
        if (!isSha(entry.sha) || !isSha(entry.commit?.tree?.sha)) throw new Error('Invalid projection commit');
        if (seen.has(entry.sha)) throw new Error('Duplicate projection commit across pages');
        seen.add(entry.sha);
        const { files, unsafe } = inventory(this.publisher, entry.commit.tree.sha);
        const file = files.get(path);
        if (!file) return undefined;
        if (file === this.files.get(path)) continue;
        // The production writer created both copies together. Skip a damaged
        // historical record, but propagate incomplete Git responses and API errors.
        if (unsafe.has(slotPath(n)) || unsafe.has(path) || files.get(slotPath(n)) !== file) continue;
        let value;
        try { value = readBlob(this.publisher, file); }
        catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        try { return checkedState(value, n, true); }
        catch (error) { if (error instanceof InvalidState) continue; throw error; }
      }
      if (history.length < 100) return undefined;
    }
  }
  change(message, records) {
    const changes = [];
    for (const [path, value] of Object.entries(records)) {
      if (value === null) {
        if (this.files.has(path)) changes.push({ path, mode: '100644', type: 'blob', sha: null });
      } else {
        const content = JSON.stringify(value, null, 2) + '\n';
        if (blobId(content) === this.files.get(path)) continue;
        changes.push({ path, mode: '100644', type: 'blob', content });
      }
    }
    if (!changes.length) return false;
    const write = (path, method, body) => this.publisher.api(path, { method, body });
    const tree = write('/git/trees', 'POST', { base_tree: this.tree, tree: changes }).sha;
    if (!isSha(tree)) throw new Error('Invalid state tree');
    const commit = write('/git/commits', 'POST', { tree, parents: [this.head], message }).sha;
    if (!isSha(commit)) throw new Error('Invalid state commit');
    const updated = write('/git/refs/heads/' + stateBranch, 'PATCH', { sha: commit, force: false });
    if (updated?.object?.sha !== commit) throw new Error('Unconfirmed state ref update');
    this.tree = tree;
    this.head = commit;
    for (const { path, content } of changes) {
      if (content === undefined) this.files.delete(path);
      else {
        const sha = blobId(content);
        this.files.set(path, sha);
        this.cache.set(sha, records[path]);
      }
    }
    return true;
  }
}

export function assertProjection(store, allowed, now = Date.now()) {
  if (store.unknown.length) throw new Error('Unexpected watched paths: ' + store.unknown.join(', '));
  function verifyPin(state, n) {
    if (allowed && state && !allowed.includes(state.chartRevision)) {
      throw new Error('Unapproved chartRevision for PR #' + n + ': ' + state.chartRevision);
    }
  }
  for (const n of new Set([...store.slots, ...store.projections])) {
    const source = checkedState(store.read(slotPath(n)), n);
    const deployment = checkedState(store.read(projectionPath(n)), n, true);
    verifyPin(deployment, n);
    if (!isDeepStrictEqual(pinnedState(source), deployment)) {
      throw new Error('Projection does not match slot #' + n);
    }
  }
  for (const n of store.tickets) {
    const ticket = checkedTicket(store.read(ticketPath(n)), n, store.pending.has(n));
    if (inGrace(ticket, now)) verifyPin(pinnedState(ticket.previous), n);
  }
}
