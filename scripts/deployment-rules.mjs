// Policy generation is offline. Approval and workflow checks use read-only GitHub requests.
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const modes = ['writers', 'history'];
const refs = ['refs/heads/preview-state', 'refs/heads/main-deploy'];

export function deploymentRules(mode, app, recoveryTeam) {
  const validID = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
  if (!modes.includes(mode) || !validID(app) ||
      (recoveryTeam !== undefined && !validID(recoveryTeam))) {
    throw new Error('Usage: node scripts/deployment-rules.mjs writers|history APP_ID [RECOVERY_TEAM_ID]');
  }
  const writers = [{ actor_type: 'Integration', actor_id: Number(app), bypass_mode: 'always' }];
  if (recoveryTeam) writers.push({ actor_type: 'Team', actor_id: Number(recoveryTeam), bypass_mode: 'always' });
  return {
    name: 'Deployment branches: ' + mode, target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: refs, exclude: [] } },
    bypass_actors: mode === 'writers' ? writers : [],
    rules: mode === 'writers' ? [{ type: 'creation' }, { type: 'update', parameters: { update_allows_fetch_and_merge: false } }] :
      [{ type: 'deletion' }, { type: 'non_fast_forward' }],
  };
}

const sorted = values => [...values].sort();
function revision(rule) {
  if (!Number.isSafeInteger(rule.id) || rule.id <= 0 || typeof rule.updated_at !== 'string' ||
      !Number.isFinite(Date.parse(rule.updated_at))) throw new Error('Missing ruleset revision');
  return { id: rule.id, updatedAt: rule.updated_at };
}
function restrictsUpdates(rule) {
  return rule.type !== 'update' || (rule.parameters?.update_allows_fetch_and_merge ?? false) === false;
}
function ghReader(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected OWNER/REPO');
  return path => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', 'repos/' + repo + path], { encoding: 'utf8' })).flat();
}

export function approveRules(read, app, recoveryTeam) {
  const result = { appId: app };
  const all = read('/rulesets?includes_parents=false&per_page=100');
  for (const mode of modes) {
    const expected = deploymentRules(mode, app, recoveryTeam);
    const matches = all.filter(r => r.name === expected.name);
    if (matches.length !== 1) throw new Error('Expected one repository ruleset named ' + expected.name);
    const [actual] = read('/rulesets/' + matches[0].id);
    const actors = rows => sorted(rows.map(a => [a.actor_type, a.actor_id, a.bypass_mode].join('/')));
    const ref = actual.conditions?.ref_name;
    if (actual.enforcement !== 'active' || actual.target !== 'branch' ||
        !ref || !isDeepStrictEqual(sorted(ref.include), sorted(refs)) || ref.exclude.length ||
        !isDeepStrictEqual(sorted(actual.rules.map(r => r.type)), sorted(expected.rules.map(r => r.type))) ||
        !actual.rules.every(restrictsUpdates) ||
        !Array.isArray(actual.bypass_actors) || !isDeepStrictEqual(actors(actual.bypass_actors), actors(expected.bypass_actors))) {
      throw new Error('Check the branch scope, enforcement and bypass actors of ' + expected.name);
    }
    result[mode] = revision(actual);
  }
  checkRules(read, result, app);
  return result;
}

export function checkRules(read, approval, app) {
  if (typeof app !== 'string' || !/^[1-9][0-9]*$/.test(app) || approval?.appId !== app) throw new Error('Unapproved deployment writer App ID');
  if (!approval?.writers || !approval?.history || approval.writers.id === approval.history.id) throw new Error('Missing approved deployment rulesets');
  for (const mode of modes) {
    const expected = approval[mode];
    if (!Number.isSafeInteger(expected.id) || expected.id <= 0) throw new Error('Invalid approved ruleset ID');
    const [rule] = read('/rulesets/' + expected.id);
    if (rule.enforcement !== 'active' || !isDeepStrictEqual(revision(rule), expected)) {
      throw new Error('Deployment rules changed; an administrator must verify the new ruleset revision');
    }
  }
  for (const ref of refs) {
    const rules = read('/rules/branches/' + ref.slice('refs/heads/'.length) + '?per_page=100');
    for (const [mode, types] of [['writers', ['creation', 'update']], ['history', ['deletion', 'non_fast_forward']]]) {
      if (!types.every(type => rules.some(rule => rule.type === type && rule.ruleset_id === approval[mode].id && restrictsUpdates(rule)))) {
        throw new Error('Approved deployment rules are not effective on ' + ref);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, arg, ...rest] = process.argv.slice(2);
  if (mode === 'approve' && rest.length >= 1 && rest.length <= 2) {
    console.log(JSON.stringify(approveRules(ghReader(arg), ...rest)));
  } else if (mode === 'check' && rest.length === 1) {
    checkRules(ghReader(arg), JSON.parse(process.env.PREVIEW_APPROVED_RULESETS || 'null'), rest[0]);
  } else {
    if (rest.length > 1) throw new Error('Too many arguments');
    console.log(JSON.stringify(deploymentRules(mode, arg, ...rest), null, 2));
  }
}
