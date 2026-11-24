import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

const caller = readFileSync(new URL('../tools/api-caller/server.py', import.meta.url), 'utf8');
const script = caller.match(/<script>([\s\S]+?)<\/script>/)[1];
const prs = [36, 37].map(number => ({
  number, sha: String(number).repeat(20), title: 'PR ' + number, imageLabel: '이미지 존재',
}));

function browser() {
  const elements = new Map();
  function field(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', checked: false, disabled: false, dataset: {}, listeners: new Map(), options: [],
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      replaceChildren(...options) { this.options = options; this.value = ''; },
      add(option) { this.options.push(option); },
    });
    return elements.get(id);
  }
  const button = field('api');
  button.dataset.endpoint = 'health';
  field('#baseUrl').value = 'https://fixture.invalid/container-2';
  const requests = [];
  vm.runInNewContext(script, {
    AbortController,
    Option: class { constructor(text, value) { this.text = text; this.value = String(value); } },
    document: { querySelector: field, querySelectorAll: () => [button] },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({
      url, options, reject, reply: data => resolve({ok: true, json: async () => data}),
    })),
  });
  const fire = (id, type) => field(id).listeners.get(type)();
  function select(id, value, type = 'change') {
    field(id).value = value;
    return fire(id, type);
  }
  function next(url) {
    const request = requests.shift();
    assert.equal(request?.url, url);
    return request;
  }
  async function load() {
    const done = fire('#refreshPr', 'click');
    next('/api/prs?images=0').reply({prs: prs.map(pr => ({...pr, imageLabel: '이미지 상태 미확인'}))});
    await setImmediate();
    next('/api/prs').reply({prs});
    await done;
  }
  return {field, fire, select, next, load};
}

test('a failed catalog refresh keeps cached PRs selectable without claiming cached images or SHAs are current', async () => {
  const {field, fire, select, next, load} = browser();
  await load();
  select('#prList', '36');
  assert.equal(field('#imageStatus').dataset.state, 'available');
  const done = fire('#refreshPr', 'click');
  assert.doesNotMatch(field('#prList').options[1].text, /이미지 존재/);
  next('/api/prs?images=0').reject(new Error('offline'));
  await done;
  select('#prList', '37');
  assert.equal(field('#prNumber').value, '37');
  assert.equal(field('#imageStatus').dataset.state, 'error');
  assert.match(field('#prInfo').textContent, /offline/);
  assert.doesNotMatch(field('#prInfo').textContent, /최신 커밋/);
  await load();
  assert.equal(field('#prList').value, '37');
  assert.equal(field('#imageStatus').dataset.state, 'available');
});

test('a slow image lookup can fail after switching to main without overwriting its status', async () => {
  const {field, fire, select, next} = browser();
  const done = fire('#refreshPr', 'click');
  next('/api/prs?images=0').reply({prs});
  await setImmediate();
  select('#prList', '36');
  assert.match(field('#imageStatus').textContent, /확인 중/);
  field('#isMain').checked = true;
  fire('#isMain', 'change');
  next('/api/prs').reject(new Error('registry timeout'));
  await done;
  assert.equal(field('#imageStatus').textContent, 'main 환경 선택됨');
  assert.equal(field('#prInfo').textContent, 'main 환경에 API를 요청합니다.');
  field('#isMain').checked = false;
  fire('#isMain', 'change');
  assert.equal(field('#prList').value, '36');
  assert.match(field('#prInfo').textContent, /registry timeout/);
});

test('choosing the empty option clears the PR, response and path while a late request finishes', async () => {
  const {field, fire, select, next, load} = browser();
  await load();
  select('#prList', '37');
  const done = fire('api', 'click');
  const old = next('/api/call');
  select('#prList', '');
  assert.equal(old.options.signal.aborted, true);
  old.reply({ok: true, status: 200, body: 'old response'});
  await done;
  assert.equal(field('#prNumber').value, '');
  assert.equal(field('#imageStatus').dataset.state, 'idle');
  assert.doesNotMatch(field('#pathPreview').textContent, /pr-37/);
  assert.equal(field('#resultTarget').textContent, '');
  assert.doesNotMatch(field('#output').textContent, /old response/);
});
