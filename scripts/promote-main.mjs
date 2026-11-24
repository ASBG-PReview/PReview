import { pathToFileURL } from 'node:url';

function validateIdentity({ repository, sha, digest }) {
  if (typeof repository !== 'string' || typeof sha !== 'string' || typeof digest !== 'string' ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha) || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error('Invalid main deployment identity');
  }
}

export function mainImageIntent(identity) {
  validateIdentity(identity);
  return JSON.stringify({ repository: identity.repository.toLowerCase(), commitSha: identity.sha,
    imageDigest: identity.digest, purpose: 'verified-main-image', version: 1 }) + '\n';
}

export async function promoteMain(api, { repository, sha, digest }) {
  validateIdentity({ repository, sha, digest });
  const root = `/repos/${repository}/git`;
  const main = () => api('GET', `${root}/ref/heads/main`);
  const deployment = () => api('GET', `${root}/ref/heads/main-deploy`);
  if ((await main()).object.sha !== sha) throw new Error('Superseded main build');
  let previous;
  try { previous = (await deployment()).object.sha; }
  catch (error) { if (error.status !== 404) throw error; }
  const commit = await api('GET', `${root}/commits/${sha}`);
  const content = JSON.stringify({ image: { repository: `ghcr.io/${repository.toLowerCase()}`, digest }, main: { commitSha: sha } }, null, 2) + '\n';
  const tree = await api('POST', `${root}/trees`, { base_tree: commit.tree.sha, tree: [
    { path: 'charts/preview-api/values-main-image.json', mode: '100644', type: 'blob', content }
  ] });
  if (previous) {
    const last = await api('GET', `${root}/commits/${previous}`);
    if (last.tree.sha === tree.sha) {
      if ((await main()).object.sha !== sha || (await deployment()).object.sha !== previous) {
        throw new Error('Deployment changed during comparison');
      }
      return previous;
    }
    // A normal rollback commit is a durable hold. Resuming requires explicit
    // authorization of this exact image and source by a deployment writer.
    const subject = last.message?.split('\n', 1)[0] || '';
    const wasPromotion = /^(?:main 배포|Deploy main) ([0-9a-f]{40})$/.exec(subject);
    const resume = subject === `main 배포 재개 ${sha} ${digest}` || subject === `Resume main ${sha} ${digest}`;
    if (!wasPromotion && !resume) {
      throw new Error('Manual deployment hold: approve the exact source SHA and digest before resuming');
    }
    if (wasPromotion?.[1] === sha) throw new Error('Source already promoted with a different deployment tree');
  }
  const next = await api('POST', `${root}/commits`, {
    message: `main 배포 ${sha}`, tree: tree.sha, parents: [previous || sha]
  });
  if ((await main()).object.sha !== sha) throw new Error('Main advanced before promotion');
  // No force: concurrent state updates must fail rather than overwrite another deployment.
  if (previous) await api('PATCH', `${root}/refs/heads/main-deploy`, { sha: next.sha, force: false });
  else await api('POST', `${root}/refs`, { ref: 'refs/heads/main-deploy', sha: next.sha });
  if ((await main()).object.sha !== sha || (await deployment()).object.sha !== next.sha) {
    throw new Error('Main or deployment advanced after the ref write; inspect the newer deployment');
  }
  return next.sha;
}

async function github(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method, headers: { Authorization: `Bearer ${method === 'GET' ? process.env.GH_TOKEN : process.env.PREVIEW_STATE_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) { const error = new Error(`GitHub ${method} failed: ${response.status}`); error.status = response.status; throw error; }
  return response.json();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const identity = { repository: process.env.REPOSITORY, sha: process.env.SHA, digest: process.env.IMAGE_DIGEST };
  if (process.argv[2] === 'intent') {
    process.stdout.write(mainImageIntent(identity));
  } else {
    if (process.argv.length !== 2 || !process.env.PREVIEW_STATE_TOKEN || !process.env.GH_TOKEN) throw new Error('Missing promotion credentials or invalid arguments');
    const deployment = await promoteMain(github, identity);
    console.log('Verified main deployment ' + deployment);
  }
}
