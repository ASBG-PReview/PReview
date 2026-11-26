import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mainImageIntent, promoteMain } from '../scripts/promote-main.mjs';

const sha = 'a'.repeat(40);
const older = 'c'.repeat(40);
const identity = { repository: 'example/preview', sha, digest: 'sha256:' + 'b'.repeat(64) };
const alternate = 'sha256:' + 'd'.repeat(64);
const idOf = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');

function fixture({ initialSha = older, subject = 'Deploy main ' + older, missing = false } = {}) {
  let main = sha;
  let ref = missing ? undefined : '1'.repeat(40);
  const calls = [];
  const commits = new Map([
    [sha, { tree: { sha: 'tested-source-tree' } }],
    [older, { tree: { sha: 'older-source-tree' } }],
  ]);
  if (ref) commits.set(ref, { message: subject, tree: { sha: initialSha } });
  const hook = {};
  const root = '/repos/example/preview/git/';
  async function api(method, url, body) {
    assert.ok(url.startsWith(root));
    const path = url.slice(root.length);
    const call = { method, path, body };
    calls.push(call);
    hook.before?.(call);
    if (method === 'GET') {
      if (path === 'ref/heads/main') return { object: { sha: main } };
      if (path === 'ref/heads/main-deploy') {
        if (!ref) throw Object.assign(Error('missing ref'), { status: 404 });
        return { object: { sha: ref } };
      }
      if (path.startsWith('commits/')) {
        const commit = commits.get(path.slice(8));
        assert.ok(commit, 'Unknown commit ' + path);
        return commit;
      }
    }
    if (method === 'POST' && path === 'trees') return { sha: idOf(body) };
    if (method === 'POST' && path === 'commits') {
      const id = idOf(body);
      commits.set(id, { message: body.message, tree: { sha: body.tree }, parents: body.parents });
      return { sha: id };
    }
    if (method === 'PATCH' && path === 'refs/heads/main-deploy') {
      assert.equal(body.force, false);
      if (commits.get(body.sha)?.parents[0] !== ref) throw Object.assign(Error('conflict'), { status: 422 });
    } else if (method === 'POST' && path === 'refs') {
      assert.equal(ref, undefined);
      assert.equal(body.ref, 'refs/heads/main-deploy');
    } else throw Error('Unexpected API ' + method + ' ' + path);
    ref = body.sha;
    hook.afterWrite?.();
    return {};
  }
  return { api, calls, hook, get ref() { return ref; },
    moveMain(value) { main = value; },
    operatorUpdate(message, tree = 'restored-tree') {
      ref = idOf([message, ref]);
      commits.set(ref, { message, tree: { sha: tree } });
      return ref;
    },
    writes: () => calls.filter(c => c.method !== 'GET' && c.path.startsWith('refs')),
  };
}

test('first main deployment pins the tested source tree and its digest', async () => {
  const f = fixture({ missing: true });
  const result = await promoteMain(f.api, identity);
  assert.equal(result, f.ref);
  const tree = f.calls.find(c => c.path === 'trees').body;
  assert.equal(tree.base_tree, 'tested-source-tree');
  assert.deepEqual(JSON.parse(tree.tree[0].content), {
    image: { repository: 'ghcr.io/example/preview', digest: identity.digest }, main: { commitSha: sha },
  });
  assert.deepEqual(f.calls.find(c => c.path === 'commits').body.parents, [sha]);
  assert.equal(f.calls.find(c => c.path === 'commits').body.message, `main 배포 ${sha}`);
  assert.equal(f.writes().length, 1);
});

test('existing promoted deployment advances once despite repeated identical delivery', async () => {
  const f = fixture();
  const previous = f.ref;
  const first = await promoteMain(f.api, identity);
  const again = await promoteMain(f.api, identity);
  assert.equal(again, first);
  assert.deepEqual(f.calls.find(c => c.path === 'commits').body.parents, [previous]);
  assert.equal(f.calls.filter(c => c.path === 'commits' && c.method === 'POST').length, 1);
  assert.equal(f.writes().length, 1);
  await assert.rejects(promoteMain(f.api, { ...identity, digest: alternate }), /different deployment tree/);
  assert.equal(f.ref, first);
});

test('successful ref write with a lost response converges on retry', async () => {
  const f = fixture();
  f.hook.afterWrite = () => { throw Error('lost response'); };
  await assert.rejects(promoteMain(f.api, identity), /lost response/);
  delete f.hook.afterWrite;
  assert.equal(await promoteMain(f.api, identity), f.ref);
  assert.equal(f.writes().length, 1);
});

test('rollback blocks late delivery until a writer explicitly resumes the same SHA and digest', async () => {
  const f = fixture();
  await promoteMain(f.api, identity);
  const rollback = f.operatorUpdate('Roll back after failed readiness');
  await assert.rejects(promoteMain(f.api, identity), /hold/);
  assert.equal(f.ref, rollback);
  f.operatorUpdate('main 배포 재개 ' + sha + ' ' + alternate);
  await assert.rejects(promoteMain(f.api, identity), /hold/);
  const resume = f.operatorUpdate('main 배포 재개 ' + sha + ' ' + identity.digest);
  await promoteMain(f.api, identity);
  assert.notEqual(f.ref, resume);
  assert.equal(f.writes().length, 2);
});

test('older English subjects and pre-existing resume approvals remain readable', async () => {
  for (const subject of ['Deploy main ' + older, 'Resume main ' + sha + ' ' + identity.digest]) {
    const f = fixture({ subject });
    assert.equal(await promoteMain(f.api, identity), f.ref);
    assert.equal(f.writes().length, 1);
  }
});

test('resuming an already restored tree clears the hold for the next main release', async () => {
  const f = fixture();
  await promoteMain(f.api, identity);
  const tree = f.calls.find(c => c.method === 'POST' && c.path === 'commits').body.tree;
  const hold = f.operatorUpdate('수동 복구 완료', tree);
  await assert.rejects(promoteMain(f.api, identity), /hold/);
  assert.equal(f.ref, hold);

  const resume = f.operatorUpdate(`main 배포 재개 ${sha} ${identity.digest}`, tree);
  const promoted = await promoteMain(f.api, identity);
  assert.notEqual(promoted, resume);
  assert.equal(await promoteMain(f.api, identity), promoted);
  f.moveMain(older);
  assert.notEqual(await promoteMain(f.api, { ...identity, sha: older }), promoted);
  assert.equal(f.writes().length, 3);
});

test('concurrent operator recovery wins the fast-forward race', async () => {
  const f = fixture();
  f.hook.before = c => { if (c.method === 'PATCH') f.operatorUpdate('Roll back now'); };
  await assert.rejects(promoteMain(f.api, identity), /conflict/);
  delete f.hook.before;
  await assert.rejects(promoteMain(f.api, identity), /hold/);
});

test('a stale build, including one superseded while preparing a commit, cannot advance a ref', async () => {
  for (const initiallyStale of [true, false]) {
    const f = fixture();
    if (initiallyStale) f.moveMain(older);
    else f.hook.before = c => { if (c.path === 'commits' && c.method === 'POST') f.moveMain(older); };
    await assert.rejects(promoteMain(f.api, identity), /superseded|advanced/i);
    assert.deepEqual(f.writes(), []);
  }
});

test('reports changes immediately after an accepted ref movement', async () => {
  const f = fixture();
  f.hook.afterWrite = () => f.moveMain(older);
  await assert.rejects(promoteMain(f.api, identity), error =>
    error.message.includes('advanced after the ref write') && error.message.includes('source=' + sha) &&
    error.message.includes('main=' + older) && error.message.includes('main-deploy='));
  assert.equal(f.writes().length, 1);
});

test('unreadable prior ref never bootstraps a new deployment', async () => {
  const f = fixture();
  f.hook.before = c => { if (c.path === 'ref/heads/main-deploy') throw Object.assign(Error('forbidden'), { status: 403 }); };
  await assert.rejects(promoteMain(f.api, identity), /forbidden/);
  assert.deepEqual(f.writes(), []);
});

test('main authorization binds a canonical repository, exact commit and digest', async () => {
  assert.equal(mainImageIntent(identity), mainImageIntent({ ...identity, repository: 'Example/Preview' }));
  assert.notEqual(mainImageIntent(identity), mainImageIntent({ ...identity, digest: alternate }));
  assert.notEqual(mainImageIntent(identity), mainImageIntent({ ...identity, sha: older }));
  const f = fixture();
  await assert.rejects(promoteMain(f.api, { ...identity, digest: 'latest' }));
  assert.throws(() => mainImageIntent({ ...identity, sha: 'main' }));
  assert.equal(f.calls.length, 0);
});
