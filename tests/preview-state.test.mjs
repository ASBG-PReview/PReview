import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, reconcileWithRetry, listCleanup, acknowledge, protectedStateDigests, readState, stateFiles, slotLimit } from '../scripts/reconcile-preview-state.mjs';
import { slotPath, projectionPath, ticketPath, cursorPath, StateStore, assertProjection, graceMs, legacyChart } from '../scripts/preview-state-store.mjs';
import { fixture, pull, state, legacy, ticket, now, chart, head, otherHead, digest, oldDigest } from './preview-state-fixture.mjs';
const run = (f, options = {}) => reconcile(f, msg => f.diagnostics.push(msg), { now, chartRevision: chart, ...options });
const deployed = (f, n) => { assert.deepEqual(f.get(slotPath(n)), f.get(projectionPath(n))); return f.get(projectionPath(n)); };
const sequence = (f, fn) => {
  const counts = new Map();
  f.beforeRead = path => {
    const n = (counts.get(path) || 0) + 1;
    counts.set(path, n);
    fn(path, n);
  };
};

test('creates separately pinned state and Argo projections in PR order with two slots', () => {
  const f = fixture({ prs: [pull(19), pull(17), pull(18)] });
  assert.equal(run(f), 0);
  assert.deepEqual(deployed(f, 17), state(17));
  assert.deepEqual(deployed(f, 18), state(18));
  assert.equal(deployed(f, 19), undefined);
  assert.equal(f.writes.length, 2);
  assertProjection(new StateStore(f));
  assert.equal(run(f), 0);
  assert.equal(f.writes.length, 2);
});

test('existing previews win over an older waiting PR and over-capacity states are not evicted', () => {
  for (const numbers of [[17, 18], [17, 18, 19]]) {
    const f = fixture({ prs: [16, ...numbers].map(n => pull(n)), slots: Object.fromEntries(numbers.map(n => [n, state(n)])) });
    assert.equal(run(f), 0);
    assert.equal(f.writes.length, 0);
    assert.equal(deployed(f, 16), undefined);
  }
});

test('an externally verified legacy combination keeps its deployed chart even during a new build failure', () => {
  const previous = {
    ...legacy(36), commitSha: '8ab731a4d08936b20c53383b7176196d3253a137',
    imageDigest: 'sha256:62e5296a302280a8ab04fcb633f3b145ec2549101fbcab398ed4b0d9d9aad8f5'
  };
  const f = fixture({ prs: [pull(36, { head: { repo: { id: 1 }, sha: otherHead } })], slots: { 36: previous }, projections: {} });
  f.resolve = () => { throw Error('new image pending'); };
  assert.throws(() => assertProjection(new StateStore(f)));
  assert.equal(run(f), 1);
  assert.deepEqual(deployed(f, 36), { ...previous, chartRevision: legacyChart });
  assertProjection(new StateStore(f));
});

test('a valid old receipt cannot pair an unknown v1 image with an untested route or chart', () => {
  for (const n of [17, 36]) {
    const f = fixture({ prs: [pull(n)], slots: { [n]: legacy(n) }, projections: {} });
    f.trustedBuilder = () => false;
    assert.ok(run(f) > 0);
    assert.equal(f.get(projectionPath(n)), undefined);
    assert.deepEqual(f.get(slotPath(n)), legacy(n));
    assert.throws(() => assertProjection(new StateStore(f)));
    f.trustedBuilder = () => true;
    assert.equal(run(f), 0);
    assert.deepEqual(deployed(f, n), state(n));
  }
});

test('a changing trusted main cannot shift a chart under an unchanged PR image', () => {
  const f = fixture({ prs: [pull(17)], slots: { 17: state(17) } });
  assert.equal(run(f, { chartRevision: '9'.repeat(40) }), 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(deployed(f, 17), state(17));
});

test('a changed verified PR head receives a new trusted chart pin', () => {
  const f = fixture({ prs: [pull(17, { head: { sha: otherHead, repo: { id: 1 } } })], slots: { 17: state(17) } });
  assert.equal(run(f, { chartRevision: '1'.repeat(40) }), 0);
  assert.deepEqual(deployed(f, 17), state(17, { commitSha: otherHead, chartRevision: '1'.repeat(40) }));
});

test('closed state is removed atomically with ticket, then lowest-numbered waiting PR admitted', () => {
  const f = fixture({ prs: [pull(17, { state: 'closed' }), pull(18), pull(19), pull(10)], slots: { 17: state(17), 18: state(18) } });
  f.afterWrite = msg => {
    if (msg.includes('프리뷰 종료')) {
      assert.deepEqual(f.get(ticketPath(17)), ticket(17));
      assert.equal(deployed(f, 17), undefined);
    }
  };
  assert.equal(run(f), 0);
  assert.deepEqual(deployed(f, 10), state(10));
  assert.equal(deployed(f, 19), undefined);
});

test('a closed slot reopened before deletion is kept', () => {
  const f = fixture({ prs: [pull(17, { state: 'closed' }), pull(18), pull(19)], slots: { 17: state(17), 18: state(18) } });
  sequence(f, (path, i) => {
    if (path === '/pulls/17' && i === 2)
      f.live.set(17, pull(17));
  });
  assert.equal(run(f), 0);
  assert.deepEqual(deployed(f, 17), state(17));
  assert.equal(deployed(f, 19), undefined);
});
for (const failure of ['none', 'close response lost', 'restore refused once'])
  test('reopen during retirement restores prior identity before waiting slot: ' + failure, async () => {
    const f = fixture({ prs: [pull(17, { state: 'closed' }), pull(18), pull(19)], slots: { 17: state(17), 18: state(18) } });
    f.afterWrite = msg => {
      if (msg.includes('프리뷰 종료')) {
        f.live.set(17, pull(17, { head: { repo: { id: 1 }, sha: otherHead } }));
        if (failure === 'close response lost')
          throw Error('lost acknowledgement');
      }
    };
    let blocked = false;
    f.beforeWrite = msg => {
      if (failure === 'restore refused once' && !blocked && msg.includes('검증된 프리뷰') && msg.includes('#17')) {
        blocked = true;
        throw Error('temporary');
      }
    };
    f.resolve = (n) => {
      if (n === 17)
        throw Error('new image pending'); return 'ghcr.io/example/preview@' + digest;
    };
    await reconcileWithRetry(f, { now, chartRevision: chart, log() { }, sleep: async () => { } });
    assert.deepEqual(deployed(f, 17), state(17));
    assert.equal(deployed(f, 19), undefined);
    assert.equal(f.get(ticketPath(17)), undefined);
  });

test('reopen on another base does not restore the slot', () => {
  const f = fixture({ prs: [pull(17, { state: 'closed' }), pull(18), pull(19)], slots: { 17: state(17), 18: state(18) } });
  f.afterWrite = msg => {
    if (msg.includes('프리뷰 종료'))
      f.live.set(17, pull(17, { base: { repo: { id: 1 }, ref: 'other' } }));
  };
  assert.equal(run(f), 0);
  assert.equal(deployed(f, 17), undefined);
  assert.deepEqual(deployed(f, 19), state(19));
  assert.deepEqual(f.get(ticketPath(17)).previous, state(17));
});

test('retarget removes both files and holds image cleanup until actual closure', () => {
  const f = fixture({ prs: [pull(17, { base: { repo: { id: 1 }, ref: 'other' } })], slots: { 17: state(17) } });
  assert.equal(run(f), 0);
  assert.equal(deployed(f, 17), undefined);
  assert.equal(f.get(ticketPath(17)).reason, 'retargeted');
  assert.deepEqual(listCleanup(f, { now: now + graceMs * 2 }), []);
  f.live.set(17, pull(17, { state: 'closed', base: { repo: { id: 1 }, ref: 'other' } }));
  run(f, { closedPr: 17 });
  assert.equal(f.get(ticketPath(17)).reason, 'closed');
});

test('an unlabelled opened PR holds its existing healthy slot', () => {
  const f = fixture({ prs: [pull(17, { labels: [] })], slots: { 17: state(17) } });
  assert.equal(run(f), 0);
  assert.equal(f.writes.length, 0);
});

test('bad slots are reserved while unrelated closures and admissions continue', () => {
  const f = fixture({
    prs: [pull(17), pull(18, { state: 'closed' }), pull(19), pull(20)],
    slots: { 17: {}, 18: state(18) }, projections: { 18: state(18) }
  });
  f.resolve = n => {
    if (n === 17)
      throw Error('cannot verify damaged slot'); return 'ghcr.io/example/preview@' + digest;
  };
  assert.ok(run(f) > 0);
  assert.deepEqual(f.get(slotPath(17)), {});
  assert.equal(deployed(f, 18), undefined);
  assert.deepEqual(deployed(f, 19), state(19));
  assert.equal(deployed(f, 20), undefined);
  assert.throws(() => assertProjection(new StateStore(f)));
  assert.throws(() => protectedStateDigests(f));
});

test('repairs a damaged source from verified projection even without a new receipt', () => {
  const f = fixture({ prs: [pull(17, { labels: [] })], slots: { 17: {} }, projections: { 17: state(17) } });
  assert.ok(run(f) > 0);
  assert.deepEqual(deployed(f, 17), state(17));
  assert.equal(run(f), 0);
});

test('invalid digest and SHA array types rejected, including noncanonical filenames', () => {
  for (const field of ['imageDigest', 'commitSha']) {
    const value = state(17);
    value[field] = [value[field]];
    const f = fixture({ slots: { 17: value } });
    assert.throws(() => readState(f, 17, f.fileSha(slotPath(17))));
    assert.throws(() => assertProjection(new StateStore(f)));
  }
  const f = fixture({ extra: { 'previews/pr-017/state.json': state(17) } });
  assert.throws(() => stateFiles(f));
  assert.throws(() => assertProjection(new StateStore(f)));
});

test('incomplete listing blocks all writes', () => {
  for (const broken of ['tree', 'PR list', 'closed list']) {
    const f = fixture({ prs: [pull(17)], cursor: { through: new Date(now - 3600000).toISOString() } });
    if (broken === 'tree')
      f.truncated = true;
    else
      f.beforeRead = path => {
        if (path.includes(broken === 'PR list' ? 'state=open' : 'state=closed'))
          throw Error('API unavailable');
      };
    assert.throws(() => run(f));
    assert.equal(f.writes.length, 0);
  }
});

test('cost scales with actionable previews rather than the full open PR list', () => {
  const prs = Array.from({ length: 250 }, (_, i) => pull(i + 1));
  const f = fixture({ prs, slots: { 1: state(1), 2: state(2) } });
  assert.equal(run(f), 0);
  assert.equal(f.reads.filter(path => /^\/pulls\/\d+$/.test(path)).length, 4);
  assert.equal(f.writes.length, 0);
});

test('head change before write is skipped, and after write triggers another pass', () => {
  for (const timing of ['before', 'after']) {
    const f = fixture({ prs: [pull(17)] });
    const advance = () => f.live.set(17, pull(17, { head: { sha: otherHead, repo: { id: 1 } } }));
    if (timing === 'before')
      sequence(f, (path, i) => {
        if (path === '/pulls/17' && i === 2)
          advance();
      });
    else
      f.afterWrite = advance;
    assert.equal(run(f), timing === 'before' ? 0 : 1);
    assert.equal(f.writes.length, timing === 'before' ? 0 : 1);
  }
});

test('a Git conflict restarts from a new immutable tree', async () => {
  const f = fixture({ prs: [pull(17)] });
  let attempts = 0;
  f.beforeWrite = () => {
    attempts++; if (attempts === 1)
      throw Error('409 conflict');
  };
  assert.throws(() => run(f), /409/);
  attempts = 0;
  assert.equal(await reconcileWithRetry(f, { now, chartRevision: chart, log() { }, sleep: async () => { } }), 0);
  assert.equal(attempts, 2);
  assert.deepEqual(deployed(f, 17), state(17));
});

test('missed closes include never-admitted previews after activation', () => {
  const at = new Date(now - 300000).toISOString();
  const f = fixture({ prs: [pull(17, { state: 'closed', updated_at: at, closed_at: at })], cursor: { through: new Date(now - 3600000).toISOString() } });
  assert.equal(run(f), 0);
  assert.equal(f.get(ticketPath(17)).previous, null);
  assert.equal(f.get(cursorPath).through, at);
  const writes = f.writes.length;
  assert.equal(run(f), 0);
  assert.equal(f.writes.length, writes);
});

test('closure before activation is not backfilled unless explicitly requested', () => {
  const at = new Date(now - 300000).toISOString();
  const f = fixture({ prs: [pull(17, { state: 'closed', updated_at: at, closed_at: at })], cursor: null });
  assert.equal(run(f), 0);
  assert.equal(f.get(ticketPath(17)), undefined);
  assert.equal(run(f, { closedPr: 17 }), 0);
  assert.equal(f.get(ticketPath(17)).reason, 'closed');
});

test('all live states and tickets in grace protect images; stale acknowledgement cannot clear a new ticket', () => {
  const oldAt = '2000-01-01T00:00:00.000Z';
  const f = fixture({
    prs: [pull(17, { state: 'closed', closed_at: oldAt }), pull(18)], slots: { 18: state(18) },
    tickets: { 17: ticket(17, { closedAt: oldAt, retiredAt: oldAt, previous: state(17, { imageDigest: oldDigest }) }) }
  });
  assert.deepEqual(protectedStateDigests(f, { now: Date.parse(oldAt) + 1000 }), new Set([oldDigest, digest]));
  assert.deepEqual(protectedStateDigests(f, { now }), new Set([digest]));
  const matches = listCleanup(f, { now });
  assert.deepEqual(matches, [{ prNumber: 17, ticketSha: f.fileSha(ticketPath(17)), closedAt: oldAt }]);
  assert.throws(() => acknowledge(f, 17, '1'.repeat(40)), /replaced/);
  acknowledge(f, 17, matches[0].ticketSha);
  acknowledge(f, 17, matches[0].ticketSha);
  assert.equal(f.get(ticketPath(17)), undefined);
});

test('an old close starts a full grace period when the slot is finally removed', () => {
  const at = new Date(now - 10 * graceMs).toISOString();
  const f = fixture({ prs: [pull(17, { state: 'closed', closed_at: at })], slots: { 17: state(17) } });
  assert.equal(run(f), 0);
  const record = f.get(ticketPath(17));
  assert.equal(record.closedAt, at);
  assert.equal(Date.parse(record.retiredAt), now);
  assert.deepEqual(listCleanup(f, { now: now + graceMs - 1 }), []);
  assert.equal(run(f, { closedPr: 17, now: now + 3600000 }), 0);
  assert.deepEqual(f.get(ticketPath(17)), record);
  assert.equal(listCleanup(f, { now: now + graceMs }).length, 1);
});

test('a reopen-close cycle invalidates the former GC ticket before reconciliation catches it', () => {
  const oldAt = '2000-01-01T00:00:00.000Z';
  const f = fixture({
    prs: [pull(17, { state: 'closed', closed_at: oldAt })],
    tickets: { 17: ticket(17, { closedAt: oldAt, retiredAt: oldAt }) }
  });
  const [pending] = listCleanup(f, { now });
  f.live.set(17, pull(17, { state: 'closed' }));
  assert.deepEqual(listCleanup(f, { now }), []);
  assert.throws(() => acknowledge(f, 17, pending.ticketSha), /no longer eligible/);
  assert.equal(run(f, { closedPr: 17 }), 0);
  assert.notEqual(f.fileSha(ticketPath(17)), pending.ticketSha);
  assert.equal(f.get(ticketPath(17)).previous, null);
  assert.throws(() => acknowledge(f, 17, pending.ticketSha), /replaced/);
});

test('unavailable registry preserves LKG and still retires confirmed closes', () => {
  const f = fixture({ prs: [pull(17, { state: 'closed' }), pull(18), pull(19)], slots: { 17: state(17), 18: state(18) } });
  let resolutions = 0;
  f.resolve = () => { resolutions++; throw Error('unexpected resolution'); };
  assert.ok(run(f, { registryUnavailable: true }) > 0);
  assert.equal(resolutions, 0);
  assert.equal(deployed(f, 17), undefined);
  assert.equal(f.get(ticketPath(17)).reason, 'closed');
  assert.deepEqual(deployed(f, 18), state(18));
  assert.equal(deployed(f, 19), undefined);
});

test('damaged copies recover the newest verified deployment across Git history pages', () => {
  const f = fixture({ prs: [pull(17, { labels: [] })], slots: { 17: state(17) } });
  const store = new StateStore(f);
  for (let i = 0; i < 102; i++) {
    const malformed = { corrupt: i };
    store.change('손상된 이력 ' + i, { [slotPath(17)]: malformed, [projectionPath(17)]: malformed });
  }
  assert.ok(run(f) > 0);
  assert.deepEqual(deployed(f, 17), state(17));
  assert.ok(f.reads.some(path => path.startsWith('/commits?') && path.endsWith('&page=2')));
  assertProjection(new StateStore(f));
});

test('a previous incarnation cannot be restored across a deleted projection', () => {
  const f = fixture({ prs: [pull(17, { labels: [] })], slots: { 17: state(17) } });
  const store = new StateStore(f);
  store.change('이전 배포 종료', { [slotPath(17)]: null, [projectionPath(17)]: null });
  store.change('손상된 새 배포', { [slotPath(17)]: {}, [projectionPath(17)]: {} });
  assert.ok(run(f) > 0);
  assert.deepEqual(deployed(f, 17), {});
  assert.throws(() => assertProjection(new StateStore(f)));
});

test('unknown watched paths stop new admissions while known closed slots retire', () => {
  const f = fixture({
    prs: [pull(17, { state: 'closed' }), pull(18)],
    slots: { 17: state(17) }, extra: { 'deployments/pr-old/state.json': state(19) }
  });
  assert.ok(run(f) > 0);
  assert.equal(deployed(f, 17), undefined);
  assert.equal(deployed(f, 18), undefined);
  assert.throws(() => assertProjection(new StateStore(f)));
  assert.throws(() => listCleanup(f), /Unexpected state paths/);
});

test('lowering capacity never evicts an existing reservation', () => {
  for (const input of ['-1', '1.5', 'NaN', '1e3', '9999999999999999999'])
    assert.throws(() => slotLimit(input));
  for (const maxSlots of ['0', '1']) {
    const f = fixture({ prs: [pull(16), pull(17)], slots: { 17: state(17) } });
    assert.equal(run(f, { maxSlots }), 0);
    assert.equal(deployed(f, 16), undefined);
    assert.deepEqual(deployed(f, 17), state(17));
  }
});

test('missed close after retarget still retires a published PR that never obtained a slot', () => {
  const f = fixture({ prs: [pull(17, { state: 'closed', base: { ref: 'release', repo: { id: 1 } } })] });
  assert.equal(run(f, { closedPr: 17 }), 0);
  assert.deepEqual(f.get(ticketPath(17)), ticket(17, { previous: null }));
});

test('unavailable repository identity cannot retire healthy slots as if they had retargeted', () => {
  const f = fixture({ prs: [pull(17)], slots: { 17: state(17) } });
  const api = f.api;
  f.api = (path, options) => path === '' ? { id: 1, full_name: 'example/preview' } : api(path, options);
  assert.throws(() => run(f), /repository identity/);
  assert.deepEqual(deployed(f, 17), state(17));
  assert.equal(f.writes.length, 0);
});

test('an incomplete individual PR is retried without blocking another eligible PR', () => {
  const f = fixture({ prs: [pull(17, { user: null }), pull(18)] });
  assert.ok(run(f) > 0);
  assert.equal(deployed(f, 17), undefined);
  assert.deepEqual(deployed(f, 18), state(18));
});
