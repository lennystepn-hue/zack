#!/usr/bin/env node
// SessionStart hook for Claude Code cloud sessions, registered in .claude/settings.json.
// Exits right away on the local machine; in the cloud it installs dependencies when they're
// missing or older than the lockfile, and points Claude at the cloud-environment skill.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.env.CLAUDE_CODE_REMOTE !== 'true') process.exit(0);

const REPO = resolve(import.meta.dirname, '..');
// this repo holds two packages: the Electron app and the Cloudflare worker
let failed = [];
for (const pkg of ['app', 'worker']) {
const ROOT = join(REPO, pkg);
const has = (f) => existsSync(join(ROOT, f));
const newer = (a, b) => !has(b) || statSync(join(ROOT, a)).mtimeMs > statSync(join(ROOT, b)).mtimeMs;
const run = (cmd) => spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'ignore' }).status === 0;

// [lockfile, what an install leaves behind (null: always run), command]
const jobs = [];
if (has('pnpm-lock.yaml')) jobs.push(['pnpm-lock.yaml', 'node_modules/.modules.yaml', 'pnpm install --frozen-lockfile']);
else if (has('yarn.lock')) jobs.push(['yarn.lock', 'node_modules', 'yarn install --immutable || yarn install --frozen-lockfile']);
// --ignore-scripts retry: native install scripts sometimes download from hosts the cloud proxy blocks.
else if (has('package-lock.json')) jobs.push(['package-lock.json', 'node_modules/.package-lock.json', 'npm ci --no-audit --no-fund || npm ci --no-audit --no-fund --ignore-scripts']);
else if (has('package.json')) jobs.push(['package.json', 'node_modules', 'npm install --no-audit --no-fund']);
if (has('uv.lock')) jobs.push(['uv.lock', '.venv', 'uv sync']);
else if (has('requirements.txt')) jobs.push(['requirements.txt', null, 'pip install -r requirements.txt']);

failed = failed.concat(jobs.filter(([lock, marker, cmd]) => (!marker || newer(lock, marker)) && !run(cmd)).map(([l, m, cmd]) => [l, m, `${pkg}: ${cmd}`]));
}
if (failed.length) console.log(`SessionStart hook: ${failed.map(([, , cmd]) => cmd.split(' || ')[0]).join(', ')} failed; run it to see the error.`);
console.log('Cloud session: API keys come from the agent proxy. Read the cloud-environment skill before calling external APIs, installing or deploying.');
