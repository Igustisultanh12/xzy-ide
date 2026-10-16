'use strict';
/**
 * CI helper: run a command, stream its output, and on failure publish the relevant part of
 * the output as GitHub annotations (visible on the run page and through the API).
 *   node scripts/ci-run.js "<title>" <command...>
 */
const { spawn } = require('child_process');

const [title, ...cmd] = process.argv.slice(2);
const child = spawn(cmd.join(' '), { shell: true, env: process.env });
let out = '';
const keep = (d) => {
  const s = d.toString();
  process.stdout.write(s);
  out += s;
  if (out.length > 2_000_000) out = out.slice(-1_000_000);
};
child.stdout.on('data', keep);
child.stderr.on('data', keep);
child.on('close', (code) => {
  if (code !== 0) {
    const lines = out.split(/\r?\n/);
    // Prefer failing test blocks / error lines with context, then the tail
    const picked = [];
    lines.forEach((l, i) => {
      if (/not ok|GAGAL|Error|error:|expected|actual|AssertionError|FAILED|⨯|failed/i.test(l)) {
        for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 8); k++) picked.push(k);
      }
    });
    const idx = [...new Set(picked)].sort((a, b) => a - b).slice(0, 400);
    const body = (idx.length ? idx.map((i) => lines[i]).join('\n') + '\n----- tail -----\n' : '') + lines.slice(-80).join('\n');
    const enc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const chunk = 6000;
    for (let i = 0, n = 0; i < body.length && n < 8; i += chunk, n++) {
      console.log(`::error title=${title} (${n + 1})::${enc(body.slice(i, i + chunk))}`);
    }
  }
  process.exit(code === null ? 1 : code);
});
