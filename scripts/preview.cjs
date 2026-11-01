'use strict';

function selectPreview(run, prs, repository) {
  if (run.conclusion !== 'success' || run.event !== 'pull_request' ||
      run.head_repository?.full_name !== repository || !/^[a-f0-9]{40}$/.test(run.head_sha)) return null;
  const matches = prs.filter(pr => pr.state === 'open' && !pr.draft &&
    pr.base.ref === 'main' && pr.base.repo.full_name === repository &&
    pr.head.repo?.full_name === repository && pr.head.sha === run.head_sha);
  return matches.length === 1 ? matches[0] : null;
}

function publishedLabels(labels, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid published SHA');
  const preserved = labels.map(label => typeof label === 'string' ? label : label.name)
    .filter(name => name !== 'preview-ready' && !name.startsWith('preview-sha-'));
  return [...new Set([...preserved, 'preview-ready', `preview-sha-${sha}`])];
}

module.exports = { selectPreview, publishedLabels };
