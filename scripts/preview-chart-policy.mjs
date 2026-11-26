import { pathToFileURL } from 'node:url';
import { legacyChart, isSha } from './preview-state-store.mjs';

// The first approved revision is used for new images. Keep earlier pins
// while a live deployment or a restorable cleanup ticket still uses them.
export function approvedCharts(value = '') {
  const revisions = value === '' ? [] : value.split(',').map(revision => revision.trim());
  if (!revisions.every(isSha)) throw new Error('Expected full commit SHAs in PREVIEW_CHART_REVISIONS');
  return [...new Set([...revisions, legacyChart])];
}

export function verifiedChart(publisher, revision) {
  if (!isSha(revision)) throw new Error('Missing approved primary chart revision');
  const git = (...args) => publisher.command('git', args, { encoding: 'utf8' }).trim();
  git('merge-base', '--is-ancestor', revision, 'HEAD');
  const tree = git('rev-parse', revision + ':charts/preview-api');
  if (!isSha(tree) || tree !== git('rev-parse', 'HEAD:charts/preview-api')) {
    throw new Error('The approved chart differs from the chart tested on the default branch');
  }
  return revision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const revisions = approvedCharts(process.env.PREVIEW_CHART_REVISIONS);
  const list = revisions.map(rev => JSON.stringify(rev)).join(' ');
  console.log('{{ if not (has .chartRevision (list ' + list + ')) }}{{ fail "unapproved chartRevision" }}{{ end }}{{ .chartRevision }}');
}
