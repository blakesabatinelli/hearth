#!/usr/bin/env node
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const labels = ['bonsai', 'extract', 'control', 'web'];
const ports = [8080, 8770, 8787, 5174];
const home = homedir();
const repo = resolve(process.env.HEARTH_REPO ?? process.cwd());
const runtime = resolve(process.env.HEARTH_RUNTIME_ROOT ?? join(home, 'Library', 'Application Support', 'Hearth'));
const launchAgents = resolve(process.env.HEARTH_LAUNCH_AGENTS_DIR ?? join(home, 'Library', 'LaunchAgents'));
const wrapper = join(repo, 'scripts', 'macos', 'hearth-launch-service.zsh');
const uid = process.getuid?.();

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderLaunchAgent(label, { repoPath = repo, runtimePath = runtime, wrapperPath = wrapper } = {}) {
  if (!labels.includes(label)) throw new Error(`unsupported Hearth service: ${label}`);
  const log = join(runtimePath, 'logs', `launchd-${label}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.hearth.${label}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>${xml(wrapperPath)}</string><string>${label}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repoPath)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>HEARTH_REPO</key><string>${xml(repoPath)}</string>
    <key>HEARTH_RUNTIME_ROOT</key><string>${xml(runtimePath)}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/opt/homebrew/opt/node@24/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

async function required(path) {
  try { await access(path); }
  catch { throw new Error(`required Hearth runtime file is missing: ${path.replace(home, '~')}`); }
}

async function prerequisites() {
  for (const path of [
    wrapper,
    join(runtime, 'models', 'bonsai', 'Bonsai-27B-Q1_0.gguf'),
    join(repo, 'apps', 'extract', '.venv', 'bin', 'hearth-extract'),
    join(repo, 'apps', 'control', 'dist', 'src', 'main.js'),
    join(repo, 'apps', 'web', 'server.mjs'),
    join(repo, 'apps', 'web', 'dist', 'index.html'),
    join(runtime, 'secrets', 'home-assistant-token'),
    join(runtime, 'secrets', 'openclaw-gateway-token'),
    join(runtime, 'secrets', 'hearth-session-secret'),
    join(runtime, 'secrets', 'hearth-actuation-allowlist'),
  ]) await required(path);
}

async function isListening(port) {
  return new Promise((resolveResult, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1200);
    socket.once('connect', () => { socket.destroy(); resolveResult(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`timed out checking loopback port ${port}`)); });
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolveResult(false);
      else reject(error);
    });
  });
}

function launchctl(args) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} failed`).trim());
}

async function generate() {
  await prerequisites();
  await mkdir(launchAgents, { recursive: true, mode: 0o700 });
  await mkdir(join(runtime, 'logs'), { recursive: true, mode: 0o700 });
  for (const label of labels) {
    const path = join(launchAgents, `app.hearth.${label}.plist`);
    await writeFile(path, renderLaunchAgent(label), { mode: 0o600 });
    await chmod(path, 0o600);
  }
  return labels.map((label) => join(launchAgents, `app.hearth.${label}.plist`));
}

async function install() {
  if (uid == null) throw new Error('launchd installation requires macOS');
  if (process.env.HEARTH_LAUNCH_AGENTS_DIR) throw new Error("install must use the user's standard LaunchAgents directory");
  await prerequisites();
  const occupied = [];
  for (const port of ports) if (await isListening(port)) occupied.push(port);
  if (occupied.length) {
    throw new Error(`refusing to start managed services over listeners on ${occupied.join(', ')}; stop the existing services first`);
  }
  const files = await generate();
  const loaded = [];
  try {
    for (const file of files) {
      launchctl(['bootstrap', `gui/${uid}`, file]);
      loaded.push(file);
    }
  } catch (error) {
    for (const file of loaded.reverse()) {
      try { launchctl(['bootout', `gui/${uid}`, file]); } catch { /* preserve original failure */ }
    }
    throw error;
  }
  console.log('Installed four loopback-only Hearth LaunchAgents. OpenClaw and Home Assistant retain their existing startup managers.');
}

async function uninstall() {
  if (uid == null) throw new Error('launchd removal requires macOS');
  for (const label of labels) {
    const file = join(launchAgents, `app.hearth.${label}.plist`);
    try { launchctl(['bootout', `gui/${uid}`, file]); } catch { /* already unloaded */ }
    await rm(file, { force: true });
  }
  console.log('Removed the Hearth LaunchAgents. Runtime data and secrets were kept.');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const command = process.argv[2];
  try {
    if (command === 'generate') {
      const files = await generate();
      console.log(`Generated ${files.length} owner-only LaunchAgent files. They are not loaded.`);
    } else if (command === 'install') {
      await install();
    } else if (command === 'uninstall') {
      await uninstall();
    } else {
      throw new Error('usage: node scripts/macos/launch-agents.mjs <generate|install|uninstall>');
    }
  } catch (error) {
    console.error(`[hearth-launch-agents] ${(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
}
