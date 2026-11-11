#!/usr/bin/env node
/**
 * Trading Monitor runner — fast production mode in the background.
 *
 *   pnpm app:start            build if needed, start in the background (no terminal needed)
 *   pnpm app:stop             stop it
 *   pnpm app:restart          stop + start
 *   pnpm app:status           is it running? are the server and web app healthy?
 *   pnpm app:logs             last lines of the logs (logs/server.log, logs/web.log)
 *   pnpm app:update           after `git pull`: stop, install, rebuild, start
 *   pnpm app:autostart on|off start automatically when you sign in to Windows
 *
 * A supervisor process keeps the server (port 4000) and the web app (port 3000) running and
 * restarts either one if it crashes (1 s → 30 s backoff). No extra dependencies.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows: always use an upper-case drive letter. If a terminal opened the folder as `d:\...`, Next's
// bundler sees some files as `d:\...` and others as `D:\...`, bundles Next twice, and the page crashes
// with "invariant expected layout router to be mounted".
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/^[a-z]:/, (d) => d.toUpperCase());
if (process.platform === 'win32' && process.cwd().toLowerCase() === ROOT.toLowerCase()) process.chdir(ROOT);
const RUN_DIR = join(ROOT, '.run');
const LOG_DIR = join(ROOT, 'logs');
const PID_FILE = join(RUN_DIR, 'supervisor.pid');
const DIST = '.next-prod'; // separate from `pnpm dev`'s .next
const WEB_PORT = 3000;
const API_PORT = 4000;
const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';

const bin = {
  prisma: join(ROOT, 'server', 'node_modules', 'prisma', 'build', 'index.js'),
  tsx: join(ROOT, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  next: join(ROOT, 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
};

const say = (msg) => console.log(msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers
function readPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

async function healthy(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }
}

function buildExists() {
  return existsSync(join(ROOT, 'web', DIST, 'BUILD_ID'));
}

function build() {
  say('Building the web app (about 30 s)…');
  const r = spawnSync(process.execPath, [bin.next, 'build'], {
    cwd: join(ROOT, 'web'),
    stdio: 'inherit',
    env: { ...process.env, NEXT_DIST_DIR: DIST, NODE_ENV: 'production' },
  });
  if (r.status !== 0) {
    say('Build failed — see the messages above.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------- commands
async function start({ rebuild = false } = {}) {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    say(`Already running (supervisor PID ${pid}). Open http://localhost:${WEB_PORT}`);
    return;
  }
  for (const [port, what] of [[API_PORT, 'server'], [WEB_PORT, 'web app']]) {
    if (await portInUse(port)) {
      say(`Port ${port} (${what}) is already in use — probably \`pnpm dev\` is running in a terminal.`);
      say('Stop it first (Ctrl + C in that terminal), then run this again.');
      process.exit(1);
    }
  }
  for (const [name, p] of Object.entries(bin)) {
    if (!existsSync(p)) {
      say(`Missing ${name} — run \`pnpm install\` first.`);
      process.exit(1);
    }
  }
  if (rebuild || !buildExists()) build();

  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, 'supervisor.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'supervise'], {
    cwd: ROOT,
    detached: true, // keeps running after this terminal closes
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));

  say('Starting in the background…');
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if ((await healthy(`http://localhost:${API_PORT}/api/health`)) && (await healthy(`http://localhost:${WEB_PORT}/manifest.webmanifest`))) {
      say(`Running. Open http://localhost:${WEB_PORT}  (stop: pnpm app:stop · status: pnpm app:status)`);
      return;
    }
  }
  say('Started, but not healthy after 60 s. Check: pnpm app:logs');
}

async function stop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    rmSync(PID_FILE, { force: true });
    say('Not running.');
    return;
  }
  killTree(pid);
  for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(250);
  rmSync(PID_FILE, { force: true });
  say('Stopped.');
}

async function status() {
  const pid = readPid();
  const running = !!pid && isAlive(pid);
  const api = await healthy(`http://localhost:${API_PORT}/api/health`);
  const web = await healthy(`http://localhost:${WEB_PORT}/manifest.webmanifest`);
  say(`Background app: ${running ? `running (supervisor PID ${pid})` : 'not running'}`);
  say(`  server  http://localhost:${API_PORT}  ${api ? 'healthy' : 'not responding'}`);
  say(`  web     http://localhost:${WEB_PORT}  ${web ? 'healthy' : 'not responding'}`);
  if (!running && (api || web)) say('  (something else is serving these ports — probably `pnpm dev` in a terminal)');
  say(`Autostart at sign-in: ${existsSync(startupFile()) ? 'on' : 'off'}`);
  say(`Logs: ${LOG_DIR}`);
}

function logs(lines = 40) {
  for (const f of ['server.log', 'web.log', 'supervisor.log']) {
    const p = join(LOG_DIR, f);
    say(`\n===== ${f} =====`);
    if (!existsSync(p)) {
      say('(empty)');
      continue;
    }
    say(readFileSync(p, 'utf8').split(/\r?\n/).slice(-lines).join('\n'));
  }
}

async function update() {
  await stop();
  say('Installing dependencies…');
  const r = spawnSync(`${pnpm} install`, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(1);
  await start({ rebuild: true });
}

// ---------------------------------------------------------------- autostart (Windows)
function startupFile() {
  const dir = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return join(dir, 'Trading Monitor.vbs');
}

function autostart(mode) {
  if (!isWin) {
    say('Autostart is set up for Windows only. On macOS/Linux, add `pnpm app:start` to your login items.');
    return;
  }
  const file = startupFile();
  if (mode === 'on') {
    // A tiny VBScript in the Startup folder runs the start command with no window. No admin rights needed.
    const cmd = `cmd /c cd /d ""${ROOT}"" && ""${process.execPath}"" scripts\\run.mjs start`;
    writeFileSync(file, `' Starts Trading Monitor in the background at sign-in (created by: pnpm app:autostart on)\r\nCreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`);
    say(`Autostart on: Trading Monitor will start when you sign in to Windows.\n  (${file})`);
  } else if (mode === 'off') {
    rmSync(file, { force: true });
    say('Autostart off.');
  } else {
    say(`Autostart is ${existsSync(file) ? 'on' : 'off'}. Use: pnpm app:autostart on | off`);
  }
}

// ---------------------------------------------------------------- supervisor (runs in the background)
function logStream(name) {
  const p = join(LOG_DIR, `${name}.log`);
  // simple rotation: keep the current log under 5 MB, one previous file
  try {
    if (statSync(p).size > 5 * 1024 * 1024) renameSync(p, `${p}.1`);
  } catch {}
  return openSync(p, 'a');
}

function supervise() {
  const stamp = () => new Date().toISOString();
  const note = (m) => appendFileSync(join(LOG_DIR, 'supervisor.log'), `${stamp()} ${m}\n`);
  note(`supervisor started (PID ${process.pid})`);

  // Database migrations + Prisma client, once, before the server starts.
  for (const args of [['migrate', 'deploy'], ['generate']]) {
    const r = spawnSync(process.execPath, [bin.prisma, ...args], { cwd: join(ROOT, 'server'), stdio: ['ignore', logStream('server'), logStream('server')], windowsHide: true });
    note(`prisma ${args.join(' ')} → exit ${r.status}`);
  }

  const procs = {
    server: { cmd: [bin.tsx, 'src/index.ts'], cwd: join(ROOT, 'server'), env: { NODE_ENV: 'production' } },
    web: { cmd: [bin.next, 'start', '-p', String(WEB_PORT)], cwd: join(ROOT, 'web'), env: { NODE_ENV: 'production', NEXT_DIST_DIR: DIST } },
  };
  const children = {};
  let stopping = false;

  const run = (name, backoff = 1000) => {
    const def = procs[name];
    const out = logStream(name);
    const startedAt = Date.now();
    const child = spawn(process.execPath, def.cmd, { cwd: def.cwd, env: { ...process.env, ...def.env }, stdio: ['ignore', out, out], windowsHide: true });
    children[name] = child;
    note(`${name} started (PID ${child.pid})`);
    child.on('exit', (code, signal) => {
      if (stopping) return;
      // Reset the backoff after a minute of healthy running.
      const next = Date.now() - startedAt > 60_000 ? 1000 : Math.min(backoff * 2, 30_000);
      note(`${name} exited (code ${code ?? signal}); restarting in ${next / 1000} s`);
      setTimeout(() => run(name, next), next);
    });
  };

  run('server');
  run('web');

  const shutdown = () => {
    stopping = true;
    for (const c of Object.values(children)) killTree(c.pid);
    note('supervisor stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------------------------------------------------------------- main
const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'start':
    await start();
    break;
  case 'stop':
    await stop();
    break;
  case 'restart':
    await stop();
    await start();
    break;
  case 'status':
    await status();
    break;
  case 'logs':
    logs(Number(arg) || 40);
    break;
  case 'update':
    await update();
    break;
  case 'build':
    build();
    break;
  case 'autostart':
    autostart(arg);
    break;
  case 'supervise':
    supervise();
    break;
  default:
    say('Usage: node scripts/run.mjs start | stop | restart | status | logs [n] | update | build | autostart on|off');
}
