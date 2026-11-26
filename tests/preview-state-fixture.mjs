import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { slotPath, projectionPath, ticketPath, cursorPath } from '../scripts/preview-state-store.mjs';
export const head = 'a'.repeat(40), otherHead = 'b'.repeat(40), chart = 'c'.repeat(40);
export const digest = 'sha256:' + 'd'.repeat(64), oldDigest = 'sha256:' + 'e'.repeat(64);
export const now = Date.parse('2026-11-24T08:00:00Z');
export const repo = { full_name: 'example/preview', id: 1, default_branch: 'main' };
const time = new Date(now).toISOString();
export function pull(number, options = {}) {
  return {
    number, state: 'open', user: { login: 'member' }, labels: [{ name: 'preview' }],
    head: { sha: head, repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } },
    updated_at: time, closed_at: options.state === 'closed' ? time : null, ...options
  };
}
export const state = (number, changes = {}) => ({ prNumber: String(number), commitSha: head, imageDigest: digest, chartRevision: chart, ...changes });
export const legacy = number => { const { chartRevision, ...value } = state(number); return value; };
export const ticket = (n, changes = {}) => ({ prNumber: String(n), reason: 'closed', closedAt: time, retiredAt: time, previous: state(n), ...changes });
const hash = value => createHash('sha1').update(value).digest('hex');
const blobId = text => hash('blob ' + Buffer.byteLength(text) + '\0' + text);
export function fixture({ prs = [], slots = {}, projections = slots, tickets = {}, extra = {}, cursor = { through: time } } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  const live = new Map(prs.map(pr => [pr.number, pr]));
  const writes = [], reads = [], diagnostics = [];
  const values = { ...extra };
  if (cursor)
    values[cursorPath] = cursor;
  for (const [n, value] of Object.entries(slots))
    values[slotPath(n)] = value;
  for (const [n, value] of Object.entries(projections))
    values[projectionPath(n)] = value;
  for (const [n, value] of Object.entries(tickets))
    values[ticketPath(n)] = value;
  function saveBlob(text) { const sha = blobId(text); blobs.set(sha, text); return sha; }
  function saveTree(entries) {
    const id = hash(JSON.stringify(Object.entries(entries).sort()));
    trees.set(id, entries);
    return id;
  }
  const initial = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, saveBlob(JSON.stringify(v, null, 2) + '\n')]));
  let ref = hash('initial');
  commits.set(ref, { tree: { sha: saveTree(initial) } });
  function entries() { return trees.get(commits.get(ref).tree.sha); }
  const f = {
    live, writes, reads, diagnostics, now, chartRevision: chart,
    get(path) { return entries()[path] && JSON.parse(blobs.get(entries()[path])); },
    fileSha(path) { return entries()[path]; },
    command(program, args) { assert.equal(program, 'git'); assert.deepEqual(args, ['rev-parse', 'HEAD']); return chart + '\n'; },
    resolve() { return 'ghcr.io/example/preview@' + digest; },
    trustedBuilder() { return true; },
    api(path, options = {}) {
      const method = options.method || 'GET';
      if (method === 'GET') {
        reads.push(path);
        if (f.beforeRead)
          f.beforeRead(path);
        if (path === '')
          return repo;
        if (path === '/git/ref/heads/preview-state')
          return { object: { sha: ref } };
        if (path.startsWith('/commits?')) {
          const query = new URLSearchParams(path.split('?')[1]);
          const file = query.get('path');
          const history = [];
          for (let sha = query.get('sha'); sha;) {
            const commit = commits.get(sha);
            const parent = commit.parents?.[0];
            const before = parent && trees.get(commits.get(parent).tree.sha)[file];
            if (trees.get(commit.tree.sha)[file] !== before)
              history.push({ sha, commit: { tree: commit.tree } });
            sha = parent;
          }
          const size = Number(query.get('per_page'));
          const offset = (Number(query.get('page')) - 1) * size;
          return history.slice(offset, offset + size);
        }
        if (path.startsWith('/git/commits/'))
          return commits.get(path.split('/').at(-1));
        if (path.startsWith('/git/trees/')) {
          const revision = path.split('/').at(-1).split('?')[0];
          const data = revision === 'preview-state' ? entries() : trees.get(revision);
          return { truncated: f.truncated || false, tree: Object.entries(data).map(([path, sha]) => ({ path, sha, type: 'blob', mode: '100644' })) };
        }
        if (path.startsWith('/git/blobs/')) {
          const text = blobs.get(path.split('/').at(-1));
          assert.notEqual(text, undefined);
          return { encoding: 'base64', content: Buffer.from(text).toString('base64') };
        }
        if (path.startsWith('/pulls?')) {
          const query = new URLSearchParams(path.split('?')[1]);
          const rows = [...live.values()].filter(pr => query.get('state') === 'all' || pr.state === query.get('state'));
          if (query.get('sort') === 'created') {
            assert.equal(query.get('direction'), 'asc');
            rows.sort((a, b) => a.number - b.number);
          } else rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
          const offset = (Number(query.get('page')) - 1) * 100;
          return rows.slice(offset, offset + 100);
        }
        if (path.startsWith('/pulls/'))
          return live.get(Number(path.split('/').at(-1)));
      }
      const body = options.body;
      if (method === 'POST' && path === '/git/trees') {
        const tree = { ...trees.get(body.base_tree) };
        for (const item of body.tree) {
          if (item.sha === null) {
            assert.ok(tree[item.path]);
            delete tree[item.path];
          }
          else
            tree[item.path] = saveBlob(item.content);
        }
        return { sha: saveTree(tree) };
      }
      if (method === 'POST' && path === '/git/commits') {
        const sha = hash(JSON.stringify(body));
        commits.set(sha, { tree: { sha: body.tree }, parents: body.parents, message: body.message });
        return { sha };
      }
      if (method === 'PATCH' && path === '/git/refs/heads/preview-state') {
        const next = commits.get(body.sha);
        assert.equal(body.force, false);
        assert.deepEqual(next.parents, [ref]);
        if (f.beforeWrite)
          f.beforeWrite(next.message);
        writes.push(next.message);
        ref = body.sha;
        if (f.afterWrite)
          f.afterWrite(next.message);
        return { object: { sha: ref } };
      }
      throw Error('Unexpected mock route: ' + method + ' ' + path);
    },
  };
  return f;
}
