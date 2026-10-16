'use strict';

/**
 * "Run" support for many languages: a command for the current file, and run
 * configurations detected from the project (package.json, artisan, pom.xml, gradle, ...).
 * Commands are PowerShell on Windows (bash elsewhere).
 */

const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';

function q(p) {
  // Quote a path for PowerShell / bash
  return isWin ? `'${String(p).replace(/'/g, "''")}'` : `'${String(p).replace(/'/g, "'\\''")}'`;
}

function then(a, b) {
  // Run b only if a succeeded (PowerShell 5 has no &&)
  return isWin ? `${a}; if ($?) { ${b} }` : `${a} && ${b}`;
}

function tmpExe(name) {
  return isWin ? `"$env:TEMP\\xzy-run-${name}.exe"` : `/tmp/xzy-run-${name}`;
}

function invoke(p) {
  return isWin ? `& ${p}` : p;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function packageManager(root) {
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  if (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) return 'bun';
  return 'npm';
}

/**
 * Command that runs a single file, or null when the type cannot be run directly.
 * rel is relative to root (forward slashes).
 */
function commandForFile(root, rel) {
  const abs = path.join(root, rel);
  const dir = path.dirname(abs);
  const ext = path.extname(rel).toLowerCase();
  const base = path.basename(rel, ext).replace(/[^\w-]/g, '_');
  const f = q(abs);
  switch (ext) {
    case '.php': return { command: `php ${f}`, needs: 'php' };
    case '.java': return { command: `java ${f}`, needs: 'java', note: 'Java 11+ menjalankan berkas sumber tunggal langsung.' };
    case '.py': return { command: `python ${f}`, needs: 'python' };
    case '.js': case '.mjs': case '.cjs': return { command: `node ${f}`, needs: 'node' };
    case '.ts': case '.mts': case '.tsx': return { command: `npx --yes tsx ${f}`, needs: 'node' };
    case '.go': return { command: `go run ${f}`, needs: 'go' };
    case '.rb': return { command: `ruby ${f}`, needs: 'ruby' };
    case '.dart': return { command: `dart run ${f}`, needs: 'dart' };
    case '.kt': return { command: then(`kotlinc ${f} -include-runtime -d ${q(path.join(dir, base + '.jar'))}`, `java -jar ${q(path.join(dir, base + '.jar'))}`), needs: 'java' };
    case '.c': return { command: then(`gcc ${f} -o ${tmpExe(base)}`, invoke(tmpExe(base))), needs: 'gcc' };
    case '.cpp': case '.cc': case '.cxx': return { command: then(`g++ -std=c++17 ${f} -o ${tmpExe(base)}`, invoke(tmpExe(base))), needs: 'gcc' };
    case '.rs': return exists(root, 'Cargo.toml') ? { command: 'cargo run', needs: 'cargo' } : { command: then(`rustc ${f} -o ${tmpExe(base)}`, invoke(tmpExe(base))), needs: 'cargo' };
    case '.cs': return { command: `dotnet run ${f}`, needs: 'dotnet', note: 'Berkas .cs tunggal butuh .NET 10; untuk proyek gunakan konfigurasi "dotnet run".' };
    case '.ps1': return isWin ? { command: `& ${f}` } : { command: `pwsh ${f}` };
    case '.bat': case '.cmd': return { command: isWin ? `& ${f}` : null };
    case '.sh': return { command: `bash ${f}` };
    case '.lua': return { command: `lua ${f}` };
    case '.pl': return { command: `perl ${f}` };
    case '.r': return { command: `Rscript ${f}` };
    case '.html': case '.htm': return { preview: `file:///${abs.replace(/\\/g, '/').replace(/^\/+/, '')}` };
    default: return null;
  }
}

/** Run configurations for the whole project. */
function detectConfigs(root) {
  const configs = [];
  const add = (label, command, extra = {}) => configs.push({ id: `${configs.length}`, label, command, ...extra });
  if (!root) return configs;

  const pkg = readJson(path.join(root, 'package.json'));
  const pm = packageManager(root);
  const runScript = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);

  if (exists(root, 'artisan')) {
    add('Laravel: php artisan serve', 'php artisan serve', { server: 'http://127.0.0.1:8000', needs: 'php' });
    add('Laravel: php artisan test', 'php artisan test', { needs: 'php' });
    if (!exists(root, 'vendor')) add('Composer install', 'composer install', { needs: 'composer' });
  } else if (exists(root, 'composer.json') || exists(root, 'index.php') || exists(root, 'public/index.php')) {
    const docroot = exists(root, 'public/index.php') ? ' -t public' : '';
    add(`PHP: server lokal (php -S)`, `php -S localhost:8000${docroot}`, { server: 'http://localhost:8000', needs: 'php' });
    const composer = readJson(path.join(root, 'composer.json'));
    if (composer && !exists(root, 'vendor')) add('Composer install', 'composer install', { needs: 'composer' });
    if (composer && composer.scripts) for (const s of Object.keys(composer.scripts).slice(0, 6)) add(`Composer: ${s}`, `composer run-script ${s}`, { needs: 'composer' });
  }

  if (pkg) {
    const scripts = pkg.scripts || {};
    if (!exists(root, 'node_modules')) add(`${pm} install`, `${pm} install`, { needs: 'node' });
    for (const s of ['dev', 'start', 'serve', 'build', 'test', 'lint', 'preview']) {
      if (scripts[s]) add(`${pm}: ${s}`, runScript(s), { needs: 'node', server: ['dev', 'start', 'serve', 'preview'].includes(s) ? guessServer(scripts[s]) : undefined });
    }
    for (const s of Object.keys(scripts)) {
      if (!configs.some((c) => c.label === `${pm}: ${s}`) && configs.length < 20) add(`${pm}: ${s}`, runScript(s), { needs: 'node' });
    }
  }

  const gradlew = isWin ? '.\\gradlew.bat' : './gradlew';
  const hasGradle = exists(root, 'build.gradle') || exists(root, 'build.gradle.kts') || exists(root, 'settings.gradle') || exists(root, 'settings.gradle.kts');
  if (hasGradle) {
    const g = exists(root, isWin ? 'gradlew.bat' : 'gradlew') ? gradlew : 'gradle';
    const android = exists(root, 'app/src/main/AndroidManifest.xml');
    if (android) {
      add('Android: build APK debug', `${g} assembleDebug`, { needs: 'java' });
      add('Android: build APK release', `${g} assembleRelease`, { needs: 'java' });
      add('Android: unit test', `${g} test`, { needs: 'java' });
    } else {
      add('Gradle: run', `${g} run`, { needs: 'java' });
      add('Gradle: build', `${g} build`, { needs: 'java' });
      add('Gradle: test', `${g} test`, { needs: 'java' });
    }
  }
  if (exists(root, 'pom.xml')) {
    const mvn = exists(root, isWin ? 'mvnw.cmd' : 'mvnw') ? (isWin ? '.\\mvnw.cmd' : './mvnw') : 'mvn';
    let pom = '';
    try { pom = fs.readFileSync(path.join(root, 'pom.xml'), 'utf8'); } catch { /* ignore */ }
    if (/spring-boot/i.test(pom)) add('Spring Boot: run', `${mvn} spring-boot:run`, { needs: 'java', server: 'http://localhost:8080' });
    add('Maven: package', `${mvn} -B package`, { needs: 'java' });
    add('Maven: test', `${mvn} -B test`, { needs: 'java' });
  }

  if (exists(root, 'manage.py')) {
    add('Django: runserver', 'python manage.py runserver', { needs: 'python', server: 'http://127.0.0.1:8000' });
  }
  if (exists(root, 'requirements.txt')) add('pip install -r requirements.txt', 'python -m pip install -r requirements.txt', { needs: 'python' });
  for (const entry of ['main.py', 'app.py']) if (exists(root, entry)) add(`Python: ${entry}`, `python ${entry}`, { needs: 'python' });
  if (exists(root, 'pyproject.toml') || exists(root, 'pytest.ini') || exists(root, 'tests')) {
    if (exists(root, 'pyproject.toml') || exists(root, 'pytest.ini')) add('Python: pytest', 'python -m pytest', { needs: 'python' });
  }

  if (exists(root, 'go.mod')) {
    add('Go: run', 'go run .', { needs: 'go' });
    add('Go: test', 'go test ./...', { needs: 'go' });
  }
  if (exists(root, 'Cargo.toml')) {
    add('Rust: cargo run', 'cargo run', { needs: 'cargo' });
    add('Rust: cargo test', 'cargo test', { needs: 'cargo' });
  }
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { entries = []; }
  if (entries.some((e) => /\.(sln|csproj|fsproj)$/i.test(e))) {
    add('.NET: dotnet run', 'dotnet run', { needs: 'dotnet' });
    add('.NET: dotnet test', 'dotnet test', { needs: 'dotnet' });
  }
  if (exists(root, 'pubspec.yaml')) {
    add('Flutter: run', 'flutter run', { needs: 'flutter' });
    add('Flutter: build apk', 'flutter build apk', { needs: 'flutter' });
  }
  if (exists(root, 'Makefile')) add('make', 'make');
  if (exists(root, 'docker-compose.yml') || exists(root, 'compose.yaml')) add('Docker: compose up', 'docker compose up', { needs: 'docker' });
  if (!configs.length && exists(root, 'index.html')) add('Pratinjau index.html', '', { preview: `file:///${path.join(root, 'index.html').replace(/\\/g, '/').replace(/^\/+/, '')}` });
  return configs;
}

function guessServer(script) {
  const s = String(script);
  if (/vite/.test(s)) return 'http://localhost:5173';
  if (/next/.test(s)) return 'http://localhost:3000';
  if (/nuxt/.test(s)) return 'http://localhost:3000';
  if (/ng serve/.test(s)) return 'http://localhost:4200';
  if (/react-scripts/.test(s)) return 'http://localhost:3000';
  if (/astro/.test(s)) return 'http://localhost:4321';
  return undefined;
}

module.exports = { commandForFile, detectConfigs };
