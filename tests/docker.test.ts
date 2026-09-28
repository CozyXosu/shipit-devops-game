import { describe, it, expect } from 'vitest';
import { createWorld } from '../server/src/world';
import { parseDockerfile, buildImage, BASE_SIZES } from '../server/src/sim/docker';
import * as fs from '../server/src/sim/fs';

const GOOD_DF = `FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install --omit=dev
USER node
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "server.js"]
`;

describe('docker simulation', () => {
  it('parses a production Dockerfile', () => {
    const p = parseDockerfile(GOOD_DF);
    expect(p.problems.length).toBe(0);
    expect(p.final?.user).toBe('node');
    expect(p.final?.expose).toContain(8080);
    expect(p.final?.healthcheck).toBeTruthy();
    expect(p.final?.cmd).toEqual(['node', 'server.js']);
  });

  it('flags unknown instructions', () => {
    const p = parseDockerfile('FROM alpine:3.19\nFROBNicate x\n');
    expect(p.problems.join(' ')).toContain('unknown instruction');
  });

  it('multi-stage detection', () => {
    const p = parseDockerfile('FROM node:20 AS build\nRUN npm ci\nFROM node:20-alpine\nCOPY --from=build /app/dist ./dist\nUSER node\nCMD ["node","server.js"]\n');
    expect(p.multiStage).toBe(true);
    expect(p.final?.copies[0].fromStage).toBe('build');
  });

  it('build produces an image with layer sizes from the base table', () => {
    const w = createWorld('DockerCo', 'you');
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/Dockerfile', GOOD_DF);
    const res = buildImage(w, 'acme/api:v1', '/opt/app/Dockerfile');
    expect(res.ok).toBe(true);
    expect(res.image?.sizeMB).toBeGreaterThan(BASE_SIZES['node:20-alpine']);
    expect(res.image?.user).toBe('node');
    // warnings for root user appear when USER missing
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/Dockerfile', 'FROM node:20\nCMD ["node","server.js"]\n');
    const res2 = buildImage(w, 'acme/api:bad', '/opt/app/Dockerfile');
    expect(res2.lines.map((l) => l.text).join('\n')).toContain('running as root');
  });

  it('missing Dockerfile fails with a docker-style error', () => {
    const w = createWorld('DockerCo', 'you');
    const res = buildImage(w, 'x', '/opt/app/Dockerfile');
    expect(res.ok).toBe(false);
    expect(res.lines[0].text).toContain('unable to prepare context');
  });
});
