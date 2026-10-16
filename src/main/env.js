'use strict';

/**
 * Environment helpers:
 *  - freshEnv(): process env with the CURRENT Windows PATH from the registry, so runtimes
 *    installed after the IDE started (winget, installers) work without restarting.
 *  - detectToolchain(): which languages/tools are installed, with versions.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

let cachedPath = null;
let cachedAt = 0;

function run(file, args, timeout = 5000, env = process.env) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim(), missing: !!(err && err.code === 'ENOENT') });
    });
  });
}

async function windowsPath() {
  if (process.platform !== 'win32') return process.env.PATH || '';
  if (cachedPath && Date.now() - cachedAt < 30000) return cachedPath;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], 8000);
  const extra = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps'),
  ];
  const fromReg = r.ok && r.out ? r.out.split(/\r?\n/).pop() : '';
  const merged = [...new Set([...(fromReg || '').split(';'), ...(process.env.Path || process.env.PATH || '').split(';'), ...extra].map((p) => p.trim()).filter(Boolean))].join(';');
  cachedPath = merged;
  cachedAt = Date.now();
  return merged;
}

async function freshEnv(base = process.env) {
  const env = { ...base };
  if (process.platform === 'win32') {
    const p = await windowsPath();
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
    env.Path = p;
  }
  return env;
}

function invalidatePath() { cachedPath = null; }

/** Tools the agent and the Run button care about. */
const TOOLS = [
  { id: 'git', label: 'Git', cmd: 'git', args: ['--version'], winget: 'Git.Git' },
  { id: 'node', label: 'Node.js', cmd: 'node', args: ['--version'], winget: 'OpenJS.NodeJS.LTS' },
  { id: 'npm', label: 'npm', cmd: 'npm', args: ['--version'], shell: true },
  { id: 'php', label: 'PHP', cmd: 'php', args: ['-v'], hint: 'https://windows.php.net/download' },
  { id: 'composer', label: 'Composer', cmd: 'composer', args: ['--version'], shell: true, hint: 'https://getcomposer.org/download/' },
  { id: 'java', label: 'Java (JDK)', cmd: 'java', args: ['-version'], winget: 'Microsoft.OpenJDK.21' },
  { id: 'javac', label: 'javac', cmd: 'javac', args: ['-version'] },
  { id: 'mvn', label: 'Maven', cmd: 'mvn', args: ['-v'], shell: true },
  { id: 'gradle', label: 'Gradle', cmd: 'gradle', args: ['--version'], shell: true },
  { id: 'python', label: 'Python', cmd: 'python', args: ['--version'], winget: 'Python.Python.3.12' },
  { id: 'go', label: 'Go', cmd: 'go', args: ['version'], winget: 'GoLang.Go' },
  { id: 'cargo', label: 'Rust (cargo)', cmd: 'cargo', args: ['--version'], winget: 'Rustlang.Rustup' },
  { id: 'dotnet', label: '.NET SDK', cmd: 'dotnet', args: ['--version'], winget: 'Microsoft.DotNet.SDK.8' },
  { id: 'gcc', label: 'GCC (C/C++)', cmd: 'gcc', args: ['--version'] },
  { id: 'ruby', label: 'Ruby', cmd: 'ruby', args: ['--version'] },
  { id: 'dart', label: 'Dart', cmd: 'dart', args: ['--version'] },
  { id: 'flutter', label: 'Flutter', cmd: 'flutter', args: ['--version'], shell: true },
  { id: 'gh', label: 'GitHub CLI', cmd: 'gh', args: ['--version'], winget: 'GitHub.cli' },
  { id: 'docker', label: 'Docker', cmd: 'docker', args: ['--version'] },
];

let toolCache = null;
let toolCacheAt = 0;

function firstVersion(out) {
  const m = String(out).match(/\d+\.\d+(?:\.\d+)?(?:[-_.][\w]+)?/);
  return m ? m[0] : (String(out).split(/\r?\n/)[0] || '').slice(0, 40);
}

async function detectToolchain({ force = false } = {}) {
  if (!force && toolCache && Date.now() - toolCacheAt < 5 * 60 * 1000) return toolCache;
  const env = await freshEnv();
  const results = await Promise.all(TOOLS.map(async (t) => {
    let r;
    if (process.platform === 'win32' && t.shell) {
      // .cmd/.bat shims (npm, mvn, gradle, composer) need the shell
      r = await run('cmd.exe', ['/d', '/s', '/c', `${t.cmd} ${t.args.join(' ')}`], 8000, env);
      if (/is not recognized/i.test(r.out)) r = { ok: false, missing: true, out: '' };
    } else {
      r = await run(t.cmd, t.args, 8000, env);
    }
    const installed = r.ok || (!r.missing && !!r.out && !/not recognized|not found/i.test(r.out));
    return { id: t.id, label: t.label, installed, version: installed ? firstVersion(r.out) : null, winget: t.winget || null, hint: t.hint || null };
  }));
  toolCache = results;
  toolCacheAt = Date.now();
  return results;
}

function toolchainSummary(list) {
  if (!list) return '';
  const have = list.filter((t) => t.installed).map((t) => `${t.label} ${t.version || ''}`.trim());
  const missing = list.filter((t) => !t.installed).map((t) => t.label);
  return `Terpasang: ${have.join(', ') || '-'}. Belum terpasang: ${missing.join(', ') || '-'}.`;
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

module.exports = { freshEnv, invalidatePath, detectToolchain, toolchainSummary, TOOLS, fileExists };
