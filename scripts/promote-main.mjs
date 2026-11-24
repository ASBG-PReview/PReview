import { pathToFileURL } from 'node:url';

export async function promoteMain(api, { repository, sha, digest, resumeFrom }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha) || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error('Invalid main deployment identity');
  }
  const root = `/repos/${repository}/git`;
  const main = () => api('GET', `${root}/ref/heads/main`);
  if ((await main()).object.sha !== sha) throw new Error('Superseded main build');
  let previous;
  try { previous = (await api('GET', `${root}/ref/heads/main-deploy`)).object.sha; }
  catch (error) { if (error.status !== 404) throw error; }
  const commit = await api('GET', `${root}/commits/${sha}`);
  const content = JSON.stringify({ image: { repository: `ghcr.io/${repository.toLowerCase()}`, digest }, main: { commitSha: sha } }, null, 2) + '\n';
  const tree = await api('POST', `${root}/trees`, { base_tree: commit.tree.sha, tree: [
    { path: 'charts/preview-api/values-main-image.json', mode: '100644', type: 'blob', content }
  ] });
  if (previous) {
    const deployed = await api('GET', `${root}/commits/${previous}`);
    if (deployed.tree.sha === tree.sha) {
      if ((await main()).object.sha !== sha) throw new Error('Main advanced during promotion check');
      return previous;
    }
    // Legacy and current automatic promotions both use this exact message.
    // A recovery commit holds the deployment until its exact SHA is approved.
    if (resumeFrom !== previous) {
      const priorPromotion = /^Deploy main ([0-9a-f]{40})$/.exec(deployed.message);
      if (!priorPromotion) throw new Error(`Manual deployment at ${previous}; approved resume required`);
      if (priorPromotion[1] === sha) throw new Error('Different deployment tree for the same main SHA');
    }
  }
  const next = await api('POST', `${root}/commits`, {
    message: `Deploy main ${sha}`, tree: tree.sha, parents: [previous || sha]
  });
  if ((await main()).object.sha !== sha) throw new Error('Main advanced before promotion');
  // No force: concurrent state updates must fail rather than overwrite another deployment.
  if (previous) await api('PATCH', `${root}/refs/heads/main-deploy`, { sha: next.sha, force: false });
  else await api('POST', `${root}/refs`, { ref: 'refs/heads/main-deploy', sha: next.sha });
  const currentHead = (await main()).object.sha;
  if (currentHead !== sha) {
    throw new Error(`Published ${sha} at ${next.sha}; main advanced to ${currentHead}. Verify its promotion.`);
  }
  return next.sha;
}

async function github(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) { const error = new Error(`GitHub ${method} failed: ${response.status}`); error.status = response.status; throw error; }
  return response.json();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deployment = await promoteMain(github, { repository: process.env.REPOSITORY, sha: process.env.SHA, digest: process.env.IMAGE_DIGEST, resumeFrom: process.env.MAIN_DEPLOY_RESUME_FROM });
  console.log(`Verified main deployment: source=${process.env.SHA} digest=${process.env.IMAGE_DIGEST} main-deploy=${deployment}`);
}
