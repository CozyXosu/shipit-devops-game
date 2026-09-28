// Kubernetes sim unit tests: manifests, pod lifecycle, CrashLoopBackOff,
// rolling updates, HPA — the m19 systems in isolation.
import { describe, it, expect } from 'vitest';
import { createWorld, tick, provisionK8sCluster, provisionLb } from '../server/src/world';
import { provisionCluster, kubectlCmd, applyManifests, k8sServes, parseManifests } from '../server/src/sim/k8s';
import { buildImage, pushToRegistry } from '../server/src/sim/docker';
import * as fs from '../server/src/sim/fs';
import { lbBackends } from '../server/src/sim/net';

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: registry.acme.dev/acme/api:v1
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
`;
const SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  type: LoadBalancer
  selector:
    app: api
  ports:
    - port: 80
      targetPort: 8080
`;

function worldWithCluster() {
  const w = createWorld('Acme Metrics', 'you');
  provisionCluster(w);
  provisionLb(w); // the cluster registers behind lb-01 like in the real chain
  // seed a Dockerfile and push an image, like m09/m10 would have
  fs.writeFile(w.hosts['web-01'].fs, '/opt/app/Dockerfile', 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nUSER node\nEXPOSE 8080\nHEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1\nCMD ["node", "server.js"]\n');
  buildImage(w, 'registry.acme.dev/acme/api:v1', '/opt/app/Dockerfile');
  pushToRegistry(w, 'registry.acme.dev/acme/api:v1');
  w.session.hostId = 'web-01';
  w.session.cwd = '/opt/app';
  return w;
}

describe('kubernetes sim', () => {
  it('provisions a cluster and refuses kubectl without one', () => {
    const w = createWorld('Acme', 'you');
    expect(kubectlCmd(w, ['kubectl', 'get', 'pods']).code).toBe(1);
    expect(provisionK8sCluster(w).ok).toBe(true);
    expect(provisionCluster(w).ok).toBe(false); // already provisioned
    expect(kubectlCmd(w, ['kubectl', 'get', 'nodes']).lines.some((l) => l.text.includes('k8s-01-node-a'))).toBe(true);
  });

  it('parses multi-doc manifests and reports broken YAML clearly', () => {
    const ok = parseManifests(DEPLOYMENT + '---\n' + SERVICE);
    expect(ok.error).toBeUndefined();
    expect(ok.manifests.map((m) => m.kind)).toEqual(['Deployment', 'Service']);
    const bad = parseManifests('kind: Deployment\nmetadata:\n  name: api\n      oops: stray');
    expect(bad.error).toBeTruthy();
  });

  it('pods crash-loop on an unknown image — real symptoms to debug', () => {
    const w = worldWithCluster();
    applyManifests(w, DEPLOYMENT.replace('acme/api:v1', 'acme/api:v99'));
    tick(w, 3);
    expect(w.k8s!.pods.every((p) => p.phase === 'CrashLoopBackOff')).toBe(true);
    const out = kubectlCmd(w, ['kubectl', 'get', 'pods']).lines.map((l) => l.text).join('\n');
    expect(out).toContain('CrashLoopBackOff');
    const desc = kubectlCmd(w, ['kubectl', 'describe', 'pod', w.k8s!.pods[0].name]);
    expect(desc.lines.some((l) => l.text.includes('Back-off pulling image'))).toBe(true);
  });

  it('pods go Pending → Running → Ready, register behind lb-01, and serve', () => {
    const w = worldWithCluster();
    const res = applyManifests(w, DEPLOYMENT + '---\n' + SERVICE);
    expect(res.ok).toBe(true);
    expect(k8sServes(w)).toBe(false); // nothing ready yet
    tick(w, 4);
    expect(w.k8s!.deployments['api'].readyReplicas).toBe(2);
    expect(k8sServes(w)).toBe(true);
    expect(lbBackends(w).some((b) => b.id === 'k8s-01' && b.healthy)).toBe(true);
  });

  it('rolling update: new revision, old pods retire, zero downtime proven', () => {
    const w = worldWithCluster();
    applyManifests(w, DEPLOYMENT + '---\n' + SERVICE);
    tick(w, 4);
    buildImage(w, 'registry.acme.dev/acme/api:v2', '/opt/app/Dockerfile');
    pushToRegistry(w, 'registry.acme.dev/acme/api:v2');
    kubectlCmd(w, ['kubectl', 'set', 'image', 'deployment/api', 'api=registry.acme.dev/acme/api:v2']);
    expect(w.k8s!.deployments['api'].revision).toBe(2);
    for (let i = 0; i < 8 && !w.k8s!.zeroDowntimeProven; i++) tick(w, 1);
    expect(w.k8s!.zeroDowntimeProven).toBe(true);
    expect(w.k8s!.deployments['api'].image).toContain('v2');
    const status = kubectlCmd(w, ['kubectl', 'rollout', 'status', 'deployment/api']);
    expect(status.lines[0].text).toContain('successfully rolled out');
    expect(kubectlCmd(w, ['kubectl', 'rollout', 'undo', 'deployment/api']).code).toBe(0);
    expect(w.k8s!.deployments['api'].image).toContain('v1');
  });

  it('HPA scales out under load and back within bounds', () => {
    const w = worldWithCluster();
    applyManifests(w, DEPLOYMENT + '---\n' + SERVICE);
    tick(w, 4);
    kubectlCmd(w, ['kubectl', 'autoscale', 'deployment/api', '--min=2', '--max=6', '--cpu-percent=70']);
    w.company.launched = true;
    w.company.users = 30000; // ~600 req/s at peak → HPA must scale out
    for (let i = 0; i < 10; i++) tick(w, 5);
    const dep = w.k8s!.deployments['api'];
    expect(dep.replicas).toBeGreaterThan(2);
    expect(dep.replicas).toBeLessThanOrEqual(6);
    expect(Object.values(w.k8s!.hpas)[0].peakedAtMin).toBeDefined();
  });

  it('scale and logs work; apply from a directory reads all yaml files', () => {
    const w = worldWithCluster();
    fs.ensureDir(w.hosts['web-01'].fs, '/opt/app/k8s');
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/k8s/deployment.yaml', DEPLOYMENT);
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/k8s/service.yaml', SERVICE);
    w.session.hostId = 'web-01';
    w.session.cwd = '/opt/app';
    const out = kubectlCmd(w, ['kubectl', 'apply', '-f', 'k8s/']);
    expect(out.lines.some((l) => l.text.includes('deployment.apps/api created'))).toBe(true);
    expect(out.lines.some((l) => l.text.includes('service/api created'))).toBe(true);
    expect(kubectlCmd(w, ['kubectl', 'scale', 'deployment/api', '--replicas=4']).code).toBe(0);
    tick(w, 4);
    expect(w.k8s!.deployments['api'].replicas).toBe(4);
    expect(kubectlCmd(w, ['kubectl', 'logs', 'deployment/api']).lines.length).toBeGreaterThan(2);
  });
});
