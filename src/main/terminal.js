'use strict';

/**
 * Integrated terminals. Uses a real pseudo-terminal (@lydell/node-pty, prebuilt for Windows)
 * when available; otherwise falls back to a piped shell with simple line editing.
 */

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

let pty = null;
try {
  // eslint-disable-next-line global-require
  pty = require('@lydell/node-pty');
} catch {
  pty = null;
}

function defaultShell() {
  if (process.platform === 'win32') {
    const pwsh = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
    if (fs.existsSync(pwsh)) return { file: pwsh, args: ['-NoLogo'] };
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-i'] };
}

class TerminalManager {
  constructor(send) {
    this.send = send; // (channel, payload) => void
    this.terms = new Map();
  }

  get mode() { return pty ? 'pty' : 'pipe'; }

  create(id, { cwd, cols = 100, rows = 30, env: baseEnv } = {}) {
    this.kill(id);
    const shell = defaultShell();
    const workDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const env = { ...(baseEnv || process.env), TERM_PROGRAM: 'xzy-ide', COLORTERM: 'truecolor' };

    if (pty) {
      try {
        const p = pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd: workDir, env, useConpty: true });
        p.onData((data) => this.send('term:data', { id, data }));
        p.onExit(({ exitCode }) => {
          this.terms.delete(id);
          this.send('term:exit', { id, code: exitCode });
        });
        this.terms.set(id, { kind: 'pty', proc: p });
        return { id, mode: 'pty', shell: path.basename(shell.file), cwd: workDir };
      } catch (e) {
        this.send('term:data', { id, data: `\r\n[pty tidak tersedia: ${e.message}; memakai mode sederhana]\r\n` });
      }
    }

    const args = process.platform === 'win32' ? ['-NoLogo', '-NoExit', '-Command', '-'] : ['-i'];
    const proc = spawn(shell.file, process.platform === 'win32' ? args : shell.args, { cwd: workDir, env, windowsHide: true });
    const t = { kind: 'pipe', proc, line: '' };
    const out = (d) => this.send('term:data', { id, data: d.toString('utf8').replace(/\r?\n/g, '\r\n') });
    proc.stdout.on('data', out);
    proc.stderr.on('data', out);
    proc.on('exit', (code) => {
      this.terms.delete(id);
      this.send('term:exit', { id, code });
    });
    proc.on('error', (e) => this.send('term:data', { id, data: `\r\nGagal menjalankan shell: ${e.message}\r\n` }));
    this.terms.set(id, t);
    if (process.platform === 'win32') proc.stdin.write('function prompt { "PS $($PWD.Path)> " }\n');
    return { id, mode: 'pipe', shell: path.basename(shell.file), cwd: workDir };
  }

  write(id, data) {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.kind === 'pty') { t.proc.write(data); return; }
    // Piped shell has no echo or line editing: do it here
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        this.send('term:data', { id, data: '\r\n' });
        t.proc.stdin.write(t.line + '\n');
        t.line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (t.line.length) {
          t.line = t.line.slice(0, -1);
          this.send('term:data', { id, data: '\b \b' });
        }
      } else if (ch === '\x03') {
        this.send('term:data', { id, data: '^C\r\n' });
        t.line = '';
      } else if (ch >= ' ' || ch === '\t') {
        t.line += ch;
        this.send('term:data', { id, data: ch });
      }
    }
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (t && t.kind === 'pty') {
      try { t.proc.resize(Math.max(cols, 10), Math.max(rows, 4)); } catch { /* closed */ }
    }
  }

  kill(id) {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    try {
      if (t.kind === 'pty') t.proc.kill();
      else if (process.platform === 'win32') spawn('taskkill', ['/pid', String(t.proc.pid), '/T', '/F'], { windowsHide: true });
      else t.proc.kill();
    } catch { /* already gone */ }
  }

  killAll() {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

module.exports = { TerminalManager };
