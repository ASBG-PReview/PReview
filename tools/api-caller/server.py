#!/usr/bin/env python3
"""Serve the local PReview API caller and proxy requests to the configured EKS ALB."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen
import json
import re
import base64
import subprocess
import ssl
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode


HOST = "127.0.0.1"
PORT = 8765
ENDPOINTS = {"health", "environment", "version"}
MAX_RESPONSE = 1_000_000
HTML = r'''<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PReview API 호출기</title>
  <style>
    :root { color-scheme: light; --ink: #182532; --muted: #637482; --line: #dbe5e6; --paper: #ffffff; --brand: #006f70; --brand-dark: #004f53; font-family: "Apple SD Gothic Neo", "Malgun Gothic", -apple-system, BlinkMacSystemFont, sans-serif; color: var(--ink); background: #edf2f2; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    .topbar { background: #12363d; color: #fff; }
    .topbar-inner { max-width: 1280px; height: 70px; margin: auto; padding: 0 40px; display: flex; align-items: center; justify-content: space-between; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 19px; font-weight: 800; letter-spacing: -.5px; }
    .brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid #75bbb2; border-radius: 9px; color: #dcf6ee; font-size: 19px; font-weight: 800; }
    .top-label { color: #bfd3d0; font-size: 12px; }
    main { max-width: 1280px; margin: 0 auto; padding: 44px 40px 72px; }
    .intro { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 30px; }
    h1 { margin: 0; font-size: clamp(30px, 3vw, 38px); letter-spacing: -1.7px; line-height: 1.25; }
    .sub { margin: 10px 0 0; color: var(--muted); font-size: 14px; line-height: 1.65; }
    .context { padding: 10px 14px; border: 1px solid #cddcda; border-radius: 8px; color: #536f70; font-size: 12px; white-space: nowrap; }
    .workspace { display: grid; grid-template-columns: minmax(340px, .84fr) minmax(0, 1.16fr); align-items: stretch; border: 1px solid #d5e1e0; border-radius: 14px; background: var(--paper); overflow: hidden; box-shadow: 0 14px 38px #1c414209; }
    .card { min-width: 0; }
    .card + .card { border-left: 1px solid var(--line); background: #fbfdfc; }
    .card-header { display: flex; gap: 14px; padding: 29px 32px 24px; border-bottom: 1px solid #e7eeee; }
    .card-icon { flex: 0 0 40px; display: grid; place-items: center; height: 40px; border-radius: 9px; background: #e2f2ef; color: #006b67; font-size: 18px; font-weight: 800; }
    .card-header h2 { margin: 0; font-size: 18px; letter-spacing: -.5px; }
    .card-header p { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
    .card-body { padding: 27px 32px 32px; }
    label.field { display: block; margin: 0 0 22px; color: #344854; font-size: 13px; font-weight: 700; }
    input[type=url], input[type=number], select { display: block; width: 100%; min-width: 0; height: 47px; margin-top: 9px; padding: 0 13px; border: 1px solid #cbd9d9; border-radius: 7px; background: #fff; color: #1c313a; font: 14px inherit; font-family: inherit; font-size: 13px; }
    input:hover, select:hover { border-color: #87a7a3; }
    input:focus-visible, select:focus-visible, button:focus-visible { outline: 3px solid #8dd4c7; outline-offset: 2px; }
    input:disabled, select:disabled { color: #929e9f; background: #f2f5f4; }
    .hint { display: block; margin-top: 8px; color: #687b80; font-size: 12px; line-height: 1.6; font-weight: 400; }
    .image-status { display: inline-flex; align-items: center; gap: 7px; margin-top: 12px; padding: 6px 10px; border-radius: 5px; background: #eef2f1; color: #566a6a; font-size: 12px; font-weight: 700; }
    .image-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .image-status[data-state="available"] { background: #dff3e9; color: #08704f; }
    .image-status[data-state="missing"] { background: #fff0db; color: #8a4b00; }
    .image-status[data-state="error"] { background: #fcebea; color: #a02e31; }
    .list-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #344854; font-size: 13px; font-weight: 700; }
    button { font-family: inherit; cursor: pointer; }
    .secondary { border: 1px solid #b7d1ce; border-radius: 7px; padding: 9px 11px; background: #fff; color: #006b65; font-size: 12px; font-weight: 700; }
    .secondary:hover { background: #e8f6f2; }
    button:disabled { opacity: .55; cursor: wait; }
    .mode { display: flex; align-items: center; gap: 10px; margin: 4px 0 21px; padding: 15px; border: 1px solid #dbe9e6; border-radius: 8px; background: #f2f8f6; font-size: 13px; font-weight: 700; color: #264b48; }
    .mode input { width: 17px; height: 17px; margin: 0; accent-color: var(--brand); }
    .mode small { margin-left: auto; color: #617f7b; font-size: 11px; font-weight: 500; }
    .preview { margin: 0; padding: 14px; border-left: 3px solid #7eb8ad; background: #f1f7f5; color: #4c6866; font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .actions-label { margin: 0 0 12px; color: #344854; font-size: 13px; font-weight: 700; }
    .buttons { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
    .buttons button { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 52px; min-width: 0; border: 1px solid #bdd6d1; border-radius: 8px; padding: 10px 6px; background: #fff; color: #17433f; font-size: 13px; font-weight: 750; }
    .buttons button:hover { border-color: #178172; background: #eaf7f3; }
    .buttons button:active { background: #d7eee8; }
    .buttons button span { color: #087560; font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .result { margin-top: 32px; }
    .result-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; color: #344854; font-size: 13px; font-weight: 700; }
    #status { color: #5d7776; font-size: 12px; font-weight: 600; text-align: right; }
    pre { min-height: 290px; max-height: 450px; overflow: auto; margin: 0; padding: 22px; border: 1px solid #29484c; border-radius: 9px; background: #143035; color: #d3ece5; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.8 ui-monospace, SFMono-Regular, Menlo, monospace; }
    #resultTarget { display: block; margin-top: 12px; color: #60777a; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
    .footer-note { margin: 19px 0 0; padding-top: 18px; border-top: 1px solid #e5eceb; color: #697e7c; font-size: 12px; line-height: 1.65; }
    @media (max-width: 780px) { main { padding: 34px 20px 50px; } .topbar-inner { padding: 0 20px; } .workspace { grid-template-columns: 1fr; } .card + .card { border-left: 0; border-top: 1px solid var(--line); } .context { display: none; } pre { min-height: 190px; } }
    @media (max-width: 420px) { .card-body { padding: 22px 20px 25px; } .card-header { padding: 24px 20px 20px; } .buttons { grid-template-columns: 1fr; } .buttons button { justify-content: flex-start; padding: 0 15px; } .mode small { display: none; } .list-heading { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
<header class="topbar"><div class="topbar-inner"><div class="brand"><span class="brand-mark">P</span> PReview</div><span class="top-label">배포 환경 확인 도구</span></div></header>
<main>
  <div class="intro"><div><h1>배포 환경을 확인하세요</h1>
  <p class="sub">PR과 main 환경의 API 응답을 한 곳에서 살펴볼 수 있습니다.</p></div><div class="context">ASBG-PReview / PReview</div></div>
  <div class="workspace">
    <section class="card" aria-labelledby="target-title">
      <div class="card-header"><span class="card-icon" aria-hidden="true">◇</span><div><h2 id="target-title">배포 환경</h2><p>조회할 환경과 PR을 선택하세요</p></div></div>
      <div class="card-body">
        <label class="field" for="baseUrl">EKS 고정 주소
          <input id="baseUrl" type="url" value="http://k8s-sbgdemo-efa2aa8cf7-2001705629.ap-northeast-2.elb.amazonaws.com/container-2" placeholder="http://...elb.amazonaws.com/container-2" required>
          <span class="hint">http:// 또는 https://를 포함해 /container-2까지 입력하세요.</span>
        </label>
        <div class="list-heading"><label for="prList">열린 PR 목록</label><button class="secondary" id="refreshPr" type="button">↻ &nbsp;목록 및 이미지 새로고침</button></div>
        <label class="field" for="prList">
          <select id="prList"><option value="">새로고침하여 PR을 불러오세요</option></select>
          <span class="image-status" id="imageStatus" data-state="idle">이미지 상태 미확인</span>
          <span class="hint" id="prInfo" aria-live="polite">PR을 새로고침하고 선택하면 이미지 상태를 확인할 수 있습니다.</span>
        </label>
        <label class="mode"><input id="isMain" type="checkbox"> main 배포 조회 <small>선택 시 PR 번호 무시</small></label>
        <label class="field" for="prNumber">PR 번호
          <input id="prNumber" type="number" min="1" step="1" placeholder="열린 PR 번호">
          <span class="hint">목록에서 선택하거나 직접 입력할 수 있습니다.</span>
        </label>
        <div class="preview" id="pathPreview"></div>
      </div>
    </section>
    <section class="card" aria-labelledby="request-title">
      <div class="card-header"><span class="card-icon" aria-hidden="true">&lt;/&gt;</span><div><h2 id="request-title">API 요청</h2><p>API를 선택하면 응답이 아래에 표시됩니다</p></div></div>
      <div class="card-body">
        <p class="actions-label">엔드포인트</p>
        <div class="buttons">
          <button type="button" data-endpoint="health"><span>GET</span>Health</button>
          <button type="button" data-endpoint="environment"><span>GET</span>Environment</button>
          <button type="button" data-endpoint="version"><span>GET</span>Version</button>
        </div>
        <div class="result">
          <div class="result-head"><span>응답 결과</span><span id="status" role="status">호출할 API를 선택하세요.</span></div>
          <pre id="output" aria-live="polite">아직 호출 결과가 없습니다.</pre>
          <span id="resultTarget"></span>
        </div>
        <p class="footer-note">GHCR 이미지가 존재하더라도 EKS 배포가 완료되지 않았을 수 있습니다.</p>
      </div>
    </section>
  </div>
</main>
<script>
  const baseInput = document.querySelector('#baseUrl');
  const mainInput = document.querySelector('#isMain');
  const prInput = document.querySelector('#prNumber');
  const preview = document.querySelector('#pathPreview');
  const output = document.querySelector('#output');
  const status = document.querySelector('#status');
  const buttons = [...document.querySelectorAll('button[data-endpoint]')];
  const prList = document.querySelector('#prList');
  const prInfo = document.querySelector('#prInfo');
  const refreshPr = document.querySelector('#refreshPr');
  const imageStatus = document.querySelector('#imageStatus');
  const resultTarget = document.querySelector('#resultTarget');
  let prs = [];
  let activeCall;

  function updatePrInfo() {
    const pr = mainInput.checked ? null : prs.find(item => String(item.number) === prInput.value.trim());
    prList.value = pr ? String(pr.number) : '';
    imageStatus.textContent = mainInput.checked ? 'main 환경 선택됨' : pr ? pr.imageLabel : '이미지 상태 미확인';
    imageStatus.dataset.state = !pr || pr.imageLabel === '이미지 상태 미확인' ? 'idle' : pr.imageLabel === '이미지 존재' ? 'available' : pr.imageLabel === '이미지 없음' ? 'missing' : 'error';
    prInfo.textContent = mainInput.checked ? 'main 환경에 API를 요청합니다.' : pr ? `최신 커밋 ${pr.sha.slice(0, 12)} 기준 · EKS 배포 상태는 별도입니다.` : 'PR을 새로고침하고 선택하면 이미지 상태를 확인할 수 있습니다.';
  }
  prList.addEventListener('change', () => {
    if (prList.value) { prInput.value = prList.value; mainInput.checked = false; refresh(); }
  });
  refreshPr.addEventListener('click', async () => {
    refreshPr.disabled = true;
    imageStatus.textContent = '이미지 상태 확인 중';
    imageStatus.dataset.state = 'idle';
    prInfo.textContent = 'GitHub와 GHCR을 조회하고 있습니다…';
    async function loadList(url) {
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '조회 실패');
      prs = data.prs;
      prList.replaceChildren(new Option(prs.length ? 'PR을 선택하세요' : '열린 PR이 없습니다', ''));
      for (const pr of prs) prList.add(new Option(`#${pr.number} ${pr.title} — ${pr.imageLabel}`, pr.number));
      updatePrInfo();
    }
    try {
      await loadList('/api/prs?images=0');
      if (prs.length) await loadList('/api/prs');
    } catch (error) {
      if (!prs.length) prList.replaceChildren(new Option('조회 실패', ''));
      imageStatus.textContent = '이미지 상태 확인 불가'; imageStatus.dataset.state = 'error';
      prInfo.textContent = prs.length ? '표시된 목록의 최신 상태를 확인하지 못했습니다. ' + error.message : error.message;
    } finally { refreshPr.disabled = false; }
  });

  function deploymentPath() {
    const base = baseInput.value.trim().replace(/\/+$/, '');
    return `${base}/${mainInput.checked ? 'main' : `pr-${prInput.value || '<PR 번호>'}`}`;
  }
  function refresh() {
    if (activeCall) { activeCall.abort(); activeCall = null; }
    buttons.forEach(item => item.disabled = false);
    status.textContent = '호출할 API를 선택하세요.';
    output.textContent = '아직 호출 결과가 없습니다.';
    resultTarget.textContent = '';
    prInput.disabled = mainInput.checked;
    prList.disabled = mainInput.checked;
    updatePrInfo();
    preview.textContent = `요청 경로 미리보기: ${deploymentPath()}/<endpoint>`;
  }
  baseInput.addEventListener('input', refresh);
  mainInput.addEventListener('change', refresh);
  prInput.addEventListener('input', refresh);
  refresh();

  buttons.forEach(button => button.addEventListener('click', async () => {
    const endpoint = button.dataset.endpoint;
    const prNumber = prInput.value.trim();
    if (!mainInput.checked && !/^[1-9]\d*$/.test(prNumber)) {
      status.textContent = '입력 확인'; output.textContent = 'PR 번호에 1 이상의 정수를 입력하세요.'; resultTarget.textContent = ''; return;
    }
    buttons.forEach(item => item.disabled = true);
    const call = new AbortController();
    activeCall = call;
    status.textContent = '호출 중…'; output.textContent = ''; resultTarget.textContent = `요청: ${deploymentPath()}/${endpoint}`;
    try {
      const response = await fetch('/api/call', {
        method: 'POST', signal: call.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: baseInput.value.trim(), isMain: mainInput.checked, prNumber, endpoint })
      });
      const data = await response.json();
      if (activeCall !== call) return;
      if (data.url) {
        resultTarget.textContent = '요청: ' + data.url + (data.finalUrl && data.finalUrl !== data.url ? ' → 최종 응답: ' + data.finalUrl : '');
      }
      status.textContent = data.status ? `HTTP ${data.status} · ${data.ok ? '성공' : '실패'}` : (data.ok ? '성공' : '호출 실패');
      const body = data.body === undefined ? '' : (typeof data.body === 'string' ? data.body : JSON.stringify(data.body, null, 2));
      output.textContent = [data.error, data.truncated ? '본문을 1,000,000바이트까지만 표시합니다.' : '', body].filter(Boolean).join('\n');
    } catch (error) {
      if (activeCall === call) { status.textContent = '호출 실패'; output.textContent = error.message; }
    } finally {
      if (activeCall === call) { activeCall = null; buttons.forEach(item => item.disabled = false); }
    }
  }));
</script>
</body>
</html>'''


def github_command(*args):
    try:
        result = subprocess.run(["gh", *args], capture_output=True, timeout=30)
    except FileNotFoundError:
        raise RuntimeError("GitHub CLI(gh)가 필요합니다. 설치 후 gh auth login을 실행하세요.")
    except subprocess.TimeoutExpired:
        raise RuntimeError("GitHub 연결 시간이 초과됐습니다.")
    if result.returncode:
        raise RuntimeError("GitHub 조회에 실패했습니다. gh auth status와 저장소 접근 권한을 확인하세요.")
    try:
        return result.stdout.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError("GitHub CLI 출력이 UTF-8 형식인지 확인하세요.") from error


def registry_token():
    # gh manages the credential locally; it is never sent to the browser.
    credential = github_command("auth", "token").strip()
    username = github_command("api", "user", "--jq", ".login").strip()
    auth = base64.b64encode(f"{username}:{credential}".encode()).decode()
    query = urlencode({"service": "ghcr.io", "scope": "repository:asbg-preview/preview:pull"})
    request = Request(f"https://ghcr.io/token?{query}", headers={"Authorization": f"Basic {auth}", "User-Agent": "PReview-local-api-caller"})
    with urlopen(request, timeout=15) as response:
        return json.load(response)["token"]


def image_status(pr, token):
    tag = f"pr-{pr['number']}-{pr['sha']}"
    request = Request(f"https://ghcr.io/v2/asbg-preview/preview/manifests/{tag}", headers={
        "Authorization": f"Bearer {token}", "User-Agent": "PReview-local-api-caller",
        "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
    }, method="HEAD")
    try:
        with urlopen(request, timeout=15):
            return "이미지 존재"
    except HTTPError as error:
        return "이미지 없음" if error.code == 404 else f"확인 불가 (HTTP {error.code})"
    except (URLError, TimeoutError, OSError, HTTPException):
        return "확인 불가 (연결 오류)"


def list_prs(include_images=True):
    raw = github_command("api", "--paginate", "--slurp", "repos/ASBG-PReview/PReview/pulls?state=open&per_page=100")
    pages = json.loads(raw)
    prs = [{"number": item["number"], "title": item["title"], "sha": item["head"]["sha"],
            "imageLabel": "이미지 상태 미확인"} for page in pages for item in page]
    if not include_images or not prs:
        return prs
    try:
        token = registry_token()
    except HTTPError as error:
        label = f"확인 불가 (GHCR 인증 HTTP {error.code})"
    except URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            label = "확인 불가 (Python SSL 인증서 오류)"
        else:
            label = "확인 불가 (GHCR 연결 오류)"
    except (TimeoutError, OSError, HTTPException):
        label = "확인 불가 (GHCR 연결 오류)"
    except (RuntimeError, KeyError, ValueError):
        label = "확인 불가 (GHCR 인증 정보 조회 오류)"
    else:
        with ThreadPoolExecutor(max_workers=6) as pool:
            for pr, label in zip(prs, pool.map(lambda item: image_status(item, token), prs)):
                pr["imageLabel"] = label
        return prs
    for pr in prs:
        pr["imageLabel"] = label
    return prs


def send_json(handler, status, body):
    payload = json.dumps(body, allow_nan=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def upstream_result(response, requested_url):
    content = response.read(MAX_RESPONSE + 1)
    truncated = len(content) > MAX_RESPONSE
    text = content[:MAX_RESPONSE].decode("utf-8", errors="replace")
    body = text
    if not truncated:
        try:
            parsed_body = json.loads(text)
            json.dumps(parsed_body, allow_nan=False)
            body = parsed_body
        except (ValueError, RecursionError):
            pass
    return {"ok": 200 <= response.status < 300, "status": response.status,
            "url": requested_url, "finalUrl": response.geturl(), "body": body, "truncated": truncated}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/api/prs", "/api/prs?images=0"):
            try:
                return send_json(self, 200, {"prs": list_prs(include_images=self.path == "/api/prs")})
            except (RuntimeError, ValueError, KeyError, TypeError):
                return send_json(self, 502, {"error": "GitHub 조회에 실패했습니다. GitHub CLI 설치, gh auth login 및 저장소 접근 권한을 확인하세요."})
        if self.path not in ("/", "/index.html"):
            return send_json(self, 404, {"error": "Not found"})
        data = HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/api/call":
            return send_json(self, 404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1:
                return send_json(self, 400, {"error": "요청 데이터를 확인하세요."})
            if length > 16_384:
                return send_json(self, 413, {"error": "Request too large"})
            values = json.loads(self.rfile.read(length))
            if not isinstance(values, dict) or not isinstance(values.get("baseUrl"), str):
                return send_json(self, 400, {"error": "고정 주소와 API를 지정하세요."})
            endpoint = values.get("endpoint")
            if endpoint not in ENDPOINTS:
                return send_json(self, 400, {"error": "Unknown endpoint"})

            raw_base = values.get("baseUrl", "").strip().rstrip("/")
            parsed = urlsplit(raw_base)
            if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.port == 0
                    or parsed.username is not None or parsed.password is not None):
                return send_json(self, 400, {"error": "고정 주소는 http:// 또는 https://가 포함된 유효한 주소여야 합니다."})
            if parsed.query or parsed.fragment:
                return send_json(self, 400, {"error": "고정 주소에 query string이나 fragment를 포함할 수 없습니다."})
            base_path = parsed.path.rstrip("/")
            if not base_path.endswith("/container-2"):
                return send_json(self, 400, {"error": "고정 주소는 /container-2까지 입력해야 합니다."})

            is_main = values.get("isMain", False)
            if not isinstance(is_main, bool):
                return send_json(self, 400, {"error": "main 선택값을 확인하세요."})
            if is_main:
                deployment = "main"
            else:
                pr_number = str(values.get("prNumber", ""))
                if not re.fullmatch(r"[1-9][0-9]*", pr_number):
                    return send_json(self, 400, {"error": "PR 번호에 1 이상의 정수를 입력하세요."})
                deployment = f"pr-{pr_number}"

            target_path = f"{base_path}/{deployment}/{endpoint}"
            target_url = urlunsplit((parsed.scheme, parsed.netloc, target_path, "", ""))
            request = Request(target_url, headers={"Accept": "application/json", "User-Agent": "PReview-local-api-caller/1.0"})
            try:
                try:
                    response = urlopen(request, timeout=15)
                except HTTPError as error:
                    response = error
                with response:
                    result = upstream_result(response, target_url)
            except (URLError, OSError, HTTPException) as error:
                reason = getattr(error, "reason", error)
                return send_json(self, 200, {"ok": False, "url": target_url, "error": f"EKS API에 연결할 수 없습니다: {reason}"})
            return send_json(self, 200, result)
        except (ValueError, TypeError, RecursionError):
            return send_json(self, 400, {"error": "요청 데이터를 확인하세요."})

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")


if __name__ == "__main__":
    print(f"PReview API 호출기: http://{HOST}:{PORT}")
    print("종료하려면 Ctrl+C를 누르세요.")
    try:
        with ThreadingHTTPServer((HOST, PORT), Handler) as server:
            server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료했습니다.")
