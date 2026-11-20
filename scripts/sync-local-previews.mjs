import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Publisher, currentPR } from './preview-publish.mjs';

export function application(repo, revision, pr, image, pullSecret) {
  const repository = 'ghcr.io/' + repo.full_name.toLowerCase();
  if (!image.startsWith(repository + '@') || !/^sha256:[a-f0-9]{64}$/.test(image.split('@')[1])) {
    throw new Error('Unexpected verified image');
  }
  return {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'Application',
    metadata: {
      name: `preview-pr-${pr.number}`, namespace: 'argocd',
      annotations: { 'preview.local/repository': repo.full_name },
      labels: { 'preview.local/managed-by': 'sync-local-previews' },
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: 'default',
      source: {
        repoURL: repo.html_url + '.git', targetRevision: revision, path: 'charts/preview-api',
        helm: { valuesObject: {
          image: { repository, digest: image.split('@')[1] },
          preview: { prNumber: String(pr.number), commitSha: pr.head.sha },
          imagePullSecrets: pullSecret ? [{ name: pullSecret }] : [],
        } },
      },
      destination: { server: 'https://kubernetes.default.svc', namespace: `preview-pr-${pr.number}` },
      syncPolicy: { automated: { prune: true, selfHeal: true }, syncOptions: ['CreateNamespace=true'] },
    },
  };
}

export function reconcile(repository, { publisher = new Publisher(repository), kubectl, pullSecret, log = console.log }) {
  const repo = publisher.api('');
  const revision = publisher.api('/commits/' + encodeURIComponent(repo.default_branch)).sha;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid chart revision');
  publisher.api('/contents/charts/preview-api/Chart.yaml?ref=' + revision);
  const existing = JSON.parse(kubectl(['-n', 'argocd', 'get', 'applications', '-l', 'preview.local/managed-by=sync-local-previews', '-o', 'json'])).items;
  const active = new Set();
  let failures = 0;
  for (let page = 1; ; page++) {
    const prs = publisher.api(`/pulls?state=open&per_page=100&page=${page}`);
    for (const pr of prs) {
      if (!currentPR(pr, pr, repo) || !pr.labels.some(label => label.name === 'preview')) continue;
      const name = `preview-pr-${pr.number}`;
      active.add(name); // Keep the previous verified deployment while a new head waits.
      try {
        if (existing.some(app => app.metadata.name === name && app.metadata.annotations?.['preview.local/repository'] !== repo.full_name)) {
          throw new Error('Application belongs to another repository');
        }
        const image = publisher.resolve(pr.number, pr.head.sha);
        const node = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'])).items[0];
        const arch = node.status.nodeInfo.architecture;
        const config = JSON.parse(publisher.command('skopeo', ['inspect', '--config', '--override-os', 'linux', '--override-arch', arch, 'docker://' + image], { encoding: 'utf8' }));
        if (config.architecture !== arch || config.os !== 'linux') throw new Error(`Image does not support linux/${arch}`);
        const live = publisher.api('/pulls/' + pr.number);
        if (!currentPR(live, pr, repo) || !live.labels.some(label => label.name === 'preview')) continue;
        const app = application(repo, revision, pr, image, pullSecret);
        kubectl(['apply', '-f', '-'], JSON.stringify(app));
        log(`Applied ${name}: ${image}`);
      } catch (error) { failures++; log(`Waiting PR #${pr.number}: ${error.message}`); }
    }
    if (prs.length < 100) break;
  }
  // Listing failures throw before cleanup; never delete another repository's apps.
  for (const app of existing) {
    if (app.metadata.annotations?.['preview.local/repository'] === repo.full_name && !active.has(app.metadata.name)) {
      kubectl(['-n', 'argocd', 'delete', 'application', app.metadata.name, '--wait=false']);
      log(`Deleting ${app.metadata.name}; namespace and credentials retained`);
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [repository, mode] = process.argv.slice(2);
  if (!repository || (mode && mode !== '--watch')) throw new Error('Usage: node scripts/sync-local-previews.mjs OWNER/REPO [--watch]');
  const context = process.env.PREVIEW_KUBE_CONTEXT || 'minikube';
  const kubectl = (args, input) => execFileSync('kubectl', ['--context', context, '--request-timeout=30s', ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  do {
    try {
      const failures = reconcile(repository, { kubectl, pullSecret: process.env.PREVIEW_PULL_SECRET });
      if (failures && !mode) process.exitCode = 1;
    } catch (error) { console.error(error.message); if (!mode) process.exitCode = 1; }
    if (mode) await new Promise(resolve => setTimeout(resolve, 30000));
  } while (mode);
}
