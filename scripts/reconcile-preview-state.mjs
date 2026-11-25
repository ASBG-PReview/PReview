import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Publisher, currentPR } from './preview-publish.mjs';
import { approvedCharts, verifiedChart } from './preview-chart-policy.mjs';
import {
  InvalidState, StateStore, inventory, pinnedState, inGrace, checkedState, checkedTicket,
  slotPath, projectionPath, ticketPath, cursorPath, isSha, isDigest, isTimestamp, readBlob, assertProjection
} from './preview-state-store.mjs';

export function slotLimit(value) {
  if (value === undefined || value === '') return 2;
  if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid PREVIEW_MAX_SLOTS');
  return Number(value);
}
const verifiedImage = (repo, digest) => 'ghcr.io/' + repo.full_name.toLowerCase() + '@' + digest;
const eligible = (pr, repo) => currentPR(pr, pr, repo) && pr.labels?.some(label => label.name === 'preview');
const targetsMain = (pr, repo) => pr.base?.repo?.id === repo.id && pr.base.ref === repo.default_branch;
const validNumber = n => Number.isSafeInteger(n) && n > 0;

export function stateFiles(publisher) {
  const { files, slots, projections, unknown } = inventory(publisher);
  if (unknown.length) throw new Error('Unexpected watched paths');
  return new Map([...new Set([...slots, ...projections])].map(n => [n, files.get(slotPath(n)) || files.get(projectionPath(n))]));
}
export function readState(publisher, number, fileSha) {
  return checkedState(readBlob(publisher, fileSha), number);
}

// A discrepancy is sufficient reason to defer registry deletion. Legacy
// single-copy inputs are retained while migrating to the new projection.
export function protectedStateDigests(publisher, { now = Date.now() } = {}) {
  const { files, slots, projections, tickets, unknown } = inventory(publisher);
  if (unknown.length) throw new Error('Unexpected watched paths');
  const roots = new Set();
  for (const n of new Set([...slots, ...projections])) {
    const raw = files.has(slotPath(n)) && readState(publisher, n, files.get(slotPath(n)));
    const deployed = files.has(projectionPath(n)) && checkedState(readBlob(publisher, files.get(projectionPath(n))), n, true);
    if (deployed && (!raw || !isDeepStrictEqual(pinnedState(raw), deployed))) {
      throw new Error('Inconsistent projection for PR #' + n);
    }
    if (!deployed && raw.chartRevision) throw new Error('Missing deployment projection for PR #' + n);
    roots.add((deployed || raw).imageDigest);
  }
  for (const n of tickets) {
    const ticket = checkedTicket(readBlob(publisher, files.get(ticketPath(n))), n);
    if (ticket.previous && inGrace(ticket, now)) roots.add(ticket.previous.imageDigest);
  }
  return roots;
}
export function listCleanup(publisher, { now = Date.now() } = {}) {
  const { files, tickets, slots, projections, unknown } = inventory(publisher);
  if (unknown.length) throw new Error('Unexpected state paths; cleanup deferred');
  const ready = [];
  for (const n of tickets) {
    if (slots.has(n) || projections.has(n)) continue;
    const ticketSha = files.get(ticketPath(n));
    const ticket = checkedTicket(readBlob(publisher, ticketSha), n);
    if (ticket.reason === 'closed' && !inGrace(ticket, now)) {
      const live = livePR(publisher, n);
      if (live.state === 'closed' && Date.parse(live.closed_at) === Date.parse(ticket.closedAt)) {
        ready.push({ prNumber: n, ticketSha, closedAt: ticket.closedAt });
      }
    }
  }
  return ready.sort((a, b) => a.prNumber - b.prNumber);
}
export function acknowledge(publisher, n, expectedSha) {
  if (!validNumber(n) || !isSha(expectedSha)) throw new Error('Invalid cleanup acknowledgement');
  const store = new StateStore(publisher);
  if (store.unknown.length) throw new Error('Unexpected state paths; acknowledgement deferred');
  const sha = store.files.get(ticketPath(n));
  if (!sha) return;
  if (sha !== expectedSha) throw new Error('Cleanup ticket was replaced; retry the new ticket');
  const ticket = checkedTicket(store.read(ticketPath(n)), n);
  const live = livePR(publisher, n);
  if (ticket.reason !== 'closed' || inGrace(ticket, Date.now()) || live.state !== 'closed' ||
    Date.parse(live.closed_at) !== Date.parse(ticket.closedAt) || store.files.has(slotPath(n)) || store.files.has(projectionPath(n))) {
    throw new Error('Cleanup ticket no longer eligible for acknowledgement');
  }
  store.change('PR #' + n + ' 이미지 정리 완료 기록', { [ticketPath(n)]: null });
}

function validOpenDetails(pr) {
  return typeof pr.base?.ref === 'string' && validNumber(pr.base?.repo?.id) &&
    typeof pr.user?.login === 'string' && typeof pr.head?.sha === 'string' &&
    (pr.head.repo === null || validNumber(pr.head.repo?.id)) && Array.isArray(pr.labels) &&
    pr.labels.every(label => typeof label?.name === 'string');
}
function livePR(publisher, n) {
  const live = publisher.api('/pulls/' + n);
  if (live?.number !== n || !['open', 'closed'].includes(live.state) || !live.base?.ref || !validNumber(live.base?.repo?.id) ||
    (live.state === 'open' && !validOpenDetails(live)) || (live.state === 'closed' && !isTimestamp(live.closed_at))) {
    throw new Error('Incomplete PR details for #' + n);
  }
  return live;
}
function openSnapshot(publisher) {
  const open = new Map();
  for (let page = 1; ; page++) {
    const rows = publisher.api('/pulls?state=open&per_page=100&page=' + page);
    if (!Array.isArray(rows)) throw new Error('Incomplete PR list');
    for (const pr of rows) {
      if (!validNumber(pr?.number) || open.has(pr.number) || pr.state !== 'open') throw new Error('Invalid PR list');
      open.set(pr.number, pr);
    }
    if (rows.length < 100) return open;
  }
}

// Resume after the last observed closure. Ignore closures from before the
// first activation unless an operator explicitly supplies --closed-pr.
function closedSince(publisher, cursor, now) {
  if (cursor === undefined) {
    // GitHub reports closure time to whole seconds. Include a close in the
    // first activation second even if it follows the initial snapshot.
    return { numbers: [], through: new Date(Math.floor(now / 1000) * 1000 - 1).toISOString() };
  }
  if (!isTimestamp(cursor.through)) throw new Error('Invalid closure scan cursor');
  const lower = Date.parse(cursor.through);
  const upper = now - 120_000; // allow public REST pages to settle before advancing the cursor
  const numbers = new Set();
  // Checkpoint at least daily even when the only activity is editing old PRs.
  // This bounds historical pages without a Git commit on every scheduled run.
  let through = Math.max(lower, Math.floor(upper / 86_400_000) * 86_400_000);
  if (upper > lower) {
    for (let page = 1; ; page++) {
      const rows = publisher.api('/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=' + page);
      if (!Array.isArray(rows)) throw new Error('Incomplete closed PR list');
      for (const pr of rows) {
        if (!validNumber(pr.number) || !isTimestamp(pr.closed_at) || !isTimestamp(pr.updated_at)) throw new Error('Invalid closed PR list');
        const at = Date.parse(pr.closed_at);
        if (at > lower && at <= upper) { numbers.add(pr.number); through = Math.max(through, at); }
      }
      if (rows.length < 100 || Date.parse(rows.at(-1).updated_at) < lower) break;
    }
  }
  return { numbers: [...numbers], through: new Date(through).toISOString() };
}

export function reconcile(publisher, log = console.log, options = {}) {
  const now = options.now ?? Date.now();
  const maxPreviews = slotLimit(options.maxSlots);
  const repo = publisher.api('');
  if (!validNumber(repo?.id) || typeof repo.default_branch !== 'string' || !repo.default_branch ||
    typeof repo.full_name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name)) throw new Error('Incomplete repository identity');
  const store = options.store || new StateStore(publisher);
  const open = openSnapshot(publisher);
  const cursor = store.read(cursorPath);
  const sweep = closedSince(publisher, cursor, now);
  const occupied = new Set([...store.slots, ...store.projections]);
  const discovered = new Set(sweep.numbers);
  if (options.closedPr) discovered.add(options.closedPr);
  const covered = new Set();
  let failures = 0;
  let allowed;
  if (options.chartConfig !== undefined) {
    try { allowed = approvedCharts(options.chartConfig); }
    catch (error) { allowed = []; failures++; log('Chart approval is invalid: ' + error.message); }
  }
  const canRestore = state => !state?.chartRevision || !allowed || allowed.includes(state.chartRevision);
  function problem(n, message) { failures++; log(`PR #${n}: ${message}`); }
  function refresh(n) {
    try { return livePR(publisher, n); }
    catch (error) { problem(n, error.message); return null; }
  }
  if (store.unknown.length) { failures++; log('Unrecognized watched paths; inspect before switching ApplicationSet or cleaning images: ' + store.unknown.join(', ')); }
  // Restorable tickets precede ordinary waiting PRs. Existing slots always win.
  const candidates = [...open.values()].filter(pr => !validOpenDetails(pr) || eligible(pr, repo));
  const priority = n => occupied.has(n) ? 0 : store.tickets.has(n) ? 1 : 2;
  const numbers = [...new Set([...occupied, ...store.tickets, ...discovered, ...candidates.map(pr => pr.number)])]
    .sort((a, b) => priority(a) - priority(b) || a - b);
  let chart = options.chartRevision;
  for (const n of numbers) {
    const hasSlot = occupied.has(n);
    if ([slotPath(n), projectionPath(n), ticketPath(n)].some(path => store.unsafe?.has(path))) {
      problem(n, 'unsafe Git entry; retained until repaired');
      continue;
    }
    // A closed ticket is durable until GC acknowledges it. Avoid one live GET
    // per old ticket unless the open snapshot or a fresh event indicates change.
    if (!hasSlot && store.tickets.has(n) && !open.has(n) && !discovered.has(n)) continue;
    if (!hasSlot && !discovered.has(n) && !store.tickets.has(n) && occupied.size >= maxPreviews) {
      log('PR #' + n + ' waiting for a preview slot');
      continue;
    }
    const pr = refresh(n);
    if (!pr) continue;
    if (pr.base.repo.id !== repo.id) { problem(n, 'PR details belong to a different repository'); continue; }
    const inScope = targetsMain(pr, repo);
    const actual = {};
    let malformed = false;
    let unreadable = false;
    for (const path of [slotPath(n), projectionPath(n)]) {
      if (!store.files.has(path)) continue;
      try { actual[path] = checkedState(store.read(path), n, path === projectionPath(n)); }
      catch (error) {
        if (error instanceof InvalidState || error instanceof SyntaxError) malformed = true;
        else unreadable = true;
        problem(n, 'invalid or unavailable state: ' + error.message);
      }
    }
    if (unreadable) continue;
    let previous = actual[projectionPath(n)] || actual[slotPath(n)];
    if (!previous && malformed && store.files.has(projectionPath(n))) {
      try { previous = store.lastProjection(n); }
      catch (error) { problem(n, 'previous projection unavailable: ' + error.message); }
    }
    previous = pinnedState(previous);
    let ticket;
    if (store.files.has(ticketPath(n))) {
      try { ticket = checkedTicket(store.read(ticketPath(n)), n); }
      catch (error) { problem(n, error.message); continue; }
    }
    const writeActive = value => store.change('PR #' + n + ' 검증된 프리뷰 상태 기록', {
      [slotPath(n)]: value, [projectionPath(n)]: value, [ticketPath(n)]: null,
    });
    const restore = value => value.chartRevision ? writeActive(value) : store.change('PR #' + n + ' 기존 프리뷰 복원', {
      [slotPath(n)]: value, [ticketPath(n)]: null,
    });
    if (pr.state === 'closed' || !inScope) {
      if (!hasSlot && pr.state === 'open') { covered.add(n); continue; }
      // A same-repository PR can have a published image without a slot, then
      // retarget away from main before it closes. Retire that tag as well.
      if (!hasSlot && !ticket && pr.head?.repo && pr.head.repo.id !== repo.id) { covered.add(n); continue; }
      if (hasSlot && !previous) { problem(n, 'retain slot; previous verified image unknown'); continue; }
      const confirm = refresh(n);
      if (!confirm || confirm.state !== pr.state || targetsMain(confirm, repo) !== inScope) continue;
      const reason = pr.state === 'closed' ? 'closed' : 'retargeted';
      const closedAt = reason === 'closed' ? confirm.closed_at : ticket?.closedAt || new Date(now).toISOString();
      if (!isTimestamp(closedAt)) { problem(n, 'invalid closure timestamp'); continue; }
      if (!ticket || ticket.reason !== reason || ticket.closedAt !== closedAt || hasSlot) {
        const retained = previous || (ticket && inGrace(ticket, now) ? ticket.previous : null);
        ticket = { prNumber: String(n), reason, closedAt, retiredAt: new Date(now).toISOString(), previous: retained };
        store.change('PR #' + n + ' 프리뷰 종료 및 이미지 정리 예약', {
          [slotPath(n)]: null, [projectionPath(n)]: null, [ticketPath(n)]: ticket,
        });
      }
      occupied.delete(n);
      covered.add(n);
      if (hasSlot && previous) {
        const after = refresh(n);
        if (!after) occupied.add(n);
        else if (after.state === 'open' && targetsMain(after, repo)) {
          if (canRestore(previous)) restore(previous);
          else problem(n, 'previous chart is no longer approved; keeping the recovery ticket');
          occupied.add(n);
          log('Restored reopened PR #' + n);
        }
      }
      continue;
    }
    covered.add(n);
    if (hasSlot && previous?.chartRevision && canRestore(previous)) {
      // The independent projection is authoritative when a single copy is
      // damaged. Also bootstrap a projection for a trusted v1 file.
      if (malformed || !isDeepStrictEqual(actual[slotPath(n)], previous) || !isDeepStrictEqual(actual[projectionPath(n)], previous)) {
        writeActive(previous);
        log('Recovered or migrated verified state for PR #' + n);
      }
    }
    if (!hasSlot && ticket && (!ticket.previous || !inGrace(ticket, now))) {
      store.change('다시 열린 PR #' + n + ' 이미지 정리 취소', { [ticketPath(n)]: null });
    }
    if (!hasSlot && (store.unknown.length || occupied.size >= maxPreviews)) {
      log('PR #' + n + ' waiting for a preview slot');
      continue;
    }
    if (!hasSlot && ticket?.previous && inGrace(ticket, now)) {
      if (ticket.reason === 'closed' && canRestore(ticket.previous)) {
        const confirm = refresh(n);
        if (!confirm || confirm.state !== 'open' || !targetsMain(confirm, repo)) continue;
        restore(ticket.previous);
        previous = ticket.previous;
        occupied.add(n);
        log('Restored previous verified state for reopened PR #' + n);
      }
    }
    if (!eligible(pr, repo)) continue;
    if (!isSha(pr.head.sha)) { problem(n, 'invalid head SHA'); continue; }
    if (options.registryUnavailable) { problem(n, 'registry unavailable; keeping last verified state'); continue; }
    let image;
    try { image = publisher.resolve(n, pr.head.sha); }
    catch (error) { problem(n, 'waiting for verified image: ' + error.message); continue; }
    const digest = typeof image === 'string' && image.split('@')[1];
    if (!isDigest(digest) || image !== verifiedImage(repo, digest)) { problem(n, 'unexpected verified image'); continue; }
    const sameImage = previous?.chartRevision && canRestore(previous) && previous.commitSha === pr.head.sha && previous.imageDigest === digest;
    if (!sameImage) {
      // A signed legacy receipt can predate the build's prefixed-route smoke
      // test. Require the PR recipe and workflow to match the trusted checkout
      // before combining an image and this chart for the first time.
      try {
        if (!publisher.trustedBuilder(pr)) throw new Error('build predates trusted route checks');
      } catch (error) {
        problem(n, 'waiting for a compatible chart and image: ' + error.message);
        continue;
      }
      try {
        if (!chart) chart = verifiedChart(publisher, (allowed || approvedCharts())[0]);
        if (!isSha(chart) || (allowed && !allowed.includes(chart))) throw new Error('Invalid or unapproved chart revision');
      } catch (error) { problem(n, 'chart promotion pending: ' + error.message); continue; }
    }
    const confirm = refresh(n);
    if (!confirm || !eligible(confirm, repo) || confirm.head.sha !== pr.head.sha) continue;
    const next = { prNumber: String(n), commitSha: pr.head.sha, imageDigest: digest, chartRevision: sameImage ? previous.chartRevision : chart };
    if (!writeActive(next)) continue;
    occupied.add(n);
    const after = refresh(n);
    if (after && (!eligible(after, repo) || after.head.sha !== pr.head.sha)) problem(n, 'PR changed during update; retry required');
  }
  // Never skip a closure whose details or state we could not confirm.
  if (sweep.numbers.every(n => covered.has(n)) && cursor?.through !== sweep.through) {
    store.change('종료된 PR 확인 시점 기록', { [cursorPath]: { through: sweep.through } });
  }
  return failures;
}

export async function reconcileWithRetry(publisher, { log = console.log, sleep = ms => new Promise(r => setTimeout(r, ms)), attempts = 3, ...options } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return reconcile(publisher, log, options); }
    catch (error) {
      if (attempt >= attempts) throw error;
      log('Refreshing Git and PR state before retry: ' + error.message);
      await sleep(attempt * 2000);
    }
  }
}

class StatePublisher extends Publisher {
  command(program, args, options = {}) {
    const { PREVIEW_STATE_TOKEN, ...env } = options.env || process.env;
    return super.command(program, args, { ...options, env });
  }
  api(path, options = {}) {
    if (!options.method || options.method === 'GET') return super.api(path, options);
    if (!['/git/trees', '/git/commits', '/git/refs/heads/preview-state'].includes(path)) throw new Error('Unexpected state write path');
    const token = process.env.PREVIEW_STATE_TOKEN;
    if (!token) throw new Error('PREVIEW_STATE_TOKEN is required for state branch writes');
    const result = this.command('gh', ['api', this.root + path, '--method', options.method, '--input', '-'], {
      input: JSON.stringify(options.body), encoding: 'utf8', env: { ...process.env, GH_TOKEN: token },
    });
    return result.trim() ? JSON.parse(result) : null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [repository, mode, arg, sha, ...extra] = process.argv.slice(2);
  const publisher = new StatePublisher(repository);
  if (mode === '--list-cleanup' && !arg) console.log(JSON.stringify(listCleanup(publisher)));
  else if (mode === '--check-projection' && !arg) assertProjection(new StateStore(publisher), approvedCharts(process.env.PREVIEW_CHART_REVISIONS));
  else if (mode === '--ack-cleanup' && !extra.length) acknowledge(publisher, Number(arg), sha);
  else if ((!mode || (mode === '--closed-pr' && /^[1-9]\d*$/.test(arg) && validNumber(Number(arg)))) && !sha) {
    if (await reconcileWithRetry(publisher, { closedPr: arg && Number(arg), maxSlots: process.env.PREVIEW_MAX_SLOTS,
      chartConfig: process.env.PREVIEW_CHART_REVISIONS ?? '', registryUnavailable: process.env.PREVIEW_REGISTRY_UNAVAILABLE === '1' })) process.exitCode = 1;
  } else throw new Error('Usage: OWNER/REPO [--closed-pr N | --list-cleanup | --ack-cleanup N TICKET_SHA | --check-projection]');
}
