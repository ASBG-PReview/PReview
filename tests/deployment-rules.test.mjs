import assert from 'node:assert/strict';
import test from 'node:test';
import { approveRules, checkRules, deploymentRules } from '../scripts/deployment-rules.mjs';

test('both ref rulesets cover exactly the two deployment branches', () => {
  for (const mode of ['writers', 'history']) {
    const rule = deploymentRules(mode, '123', '456');
    assert.equal(rule.enforcement, 'active');
    assert.equal(rule.target, 'branch');
    assert.deepEqual(rule.conditions.ref_name, {
      include: ['refs/heads/preview-state', 'refs/heads/main-deploy'], exclude: [],
    });
  }
});

test('only the writer and the optional recovery team can bypass create/update restrictions', () => {
  const writer = { actor_type: 'Integration', actor_id: 123, bypass_mode: 'always' };
  const team = { actor_type: 'Team', actor_id: 456, bypass_mode: 'always' };
  assert.deepEqual(deploymentRules('writers', '123').bypass_actors, [writer]);
  const withTeam = deploymentRules('writers', '123', '456');
  assert.deepEqual(withTeam.bypass_actors, [writer, team]);
  assert.deepEqual(withTeam.rules.map(r => r.type), ['creation', 'update']);
  const history = deploymentRules('history', '123', '456');
  assert.deepEqual(history.bypass_actors, []);
  assert.deepEqual(history.rules.map(r => r.type), ['deletion', 'non_fast_forward']);
});

test('invalid actor IDs and unknown ruleset kinds cannot produce a policy', () => {
  for (const value of [null, '0', '-1', '123.0', '', '9007199254740992', ['123']]) {
    assert.throws(() => deploymentRules('writers', value));
    assert.throws(() => deploymentRules('writers', '1', value));
  }
  assert.throws(() => deploymentRules('other', '1'));
});

test('approval inspects the real bypass list and runtime rejects policy edits or unrelated effective rules', () => {
  const updated_at = '2026-11-01T00:00:00Z';
  const rules = ['writers', 'history'].map((kind, i) => ({
    ...deploymentRules(kind, '123'), id: i + 1, updated_at,
  }));
  const effective = rules.flatMap(({ id, rules }) => rules.map(rule => ({ ...rule, ruleset_id: id })));
  const read = path => {
    if (path.startsWith('/rulesets?')) return rules;
    if (path.startsWith('/rules/branches/')) return effective;
    return [rules[Number(path.split('/').at(-1)) - 1]];
  };
  const approval = approveRules(read, '123');
  checkRules(read, approval, '123');
  assert.throws(() => checkRules(read, approval, '456'), /Unapproved/);
  const update = rules[0].rules.find(r => r.type === 'update');
  update.parameters.update_allows_fetch_and_merge = true;
  assert.throws(() => approveRules(read, '123'), /bypass actors/);
  assert.throws(() => checkRules(read, approval, '123'), /not effective/);
  update.parameters.update_allows_fetch_and_merge = false;
  rules[0].updated_at = '2026-11-02T00:00:00Z';
  assert.throws(() => checkRules(read, approval, '123'), /changed/);
  rules[0].updated_at = updated_at;
  rules[1].bypass_actors = rules[0].bypass_actors;
  assert.throws(() => approveRules(read, '123'), /bypass actors/);
  rules[1].bypass_actors = [];
  delete rules[0].bypass_actors;
  assert.throws(() => approveRules(read, '123'), /bypass actors/);
  effective[0].ruleset_id = 99;
  assert.throws(() => checkRules(read, approval, '123'), /not effective/);
});
