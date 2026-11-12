import { execFileSync } from 'node:child_process';

const number = process.argv[2];
if (!/^[1-9][0-9]*$/.test(number || '')) throw new Error('Usage: node scripts/setup-preview-pull-secret.mjs PR_NUMBER');
const context = process.env.PREVIEW_KUBE_CONTEXT || 'minikube';
const run = (program, args, input) => execFileSync(program, args, { input, encoding: 'utf8' });
const user = run('gh', ['api', 'user', '--jq', '.login']).trim();
const token = run('gh', ['auth', 'token']).trim();
run('skopeo', ['login', 'ghcr.io', '--username', user, '--password-stdin'], token);
const namespace = 'preview-pr-' + number;
const config = { auths: { 'ghcr.io': { auth: Buffer.from(user + ':' + token).toString('base64') } } };
for (const resource of [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } },
  { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'ghcr-pull', namespace }, type: 'kubernetes.io/dockerconfigjson',
    data: { '.dockerconfigjson': Buffer.from(JSON.stringify(config)).toString('base64') } },
]) {
  run('kubectl', ['--context', context, 'apply', '-f', '-'], JSON.stringify(resource));
}
console.log(`GHCR authentication configured for ${namespace}; token not printed`);
