'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { commandForFile, detectConfigs } = require('../../src/main/runconfig');
const { tmpWorkspace } = require('./helpers');

test('run commands for single files of many languages', () => {
  const root = tmpWorkspace({});
  const cases = { 'a.php': /^php /, 'Main.java': /^java /, 'x.py': /^python /, 'app.js': /^node /, 'm.go': /^go run /, 'c.c': /gcc/, 'p.cpp': /g\+\+/, 'r.rb': /^ruby /, 'd.dart': /^dart run /, 's.ts': /tsx/ };
  for (const [f, re] of Object.entries(cases)) {
    const c = commandForFile(root, f);
    assert.ok(c && re.test(c.command), `${f}: ${c && c.command}`);
  }
  assert.ok(commandForFile(root, 'index.html').preview.startsWith('file:///'));
  assert.strictEqual(commandForFile(root, 'data.bin'), null);
  assert.match(commandForFile(root, "it's.py").command, process.platform === 'win32' ? /it''s\.py/ : /it'\\''s\.py/);
});

test('detects Laravel, npm scripts, Android gradle and Spring Boot', () => {
  const laravel = tmpWorkspace({ artisan: '', 'composer.json': '{}', 'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }) });
  const l = detectConfigs(laravel).map((c) => c.label);
  assert.ok(l.includes('Laravel: php artisan serve'));
  assert.ok(l.includes('Composer install'));
  assert.ok(l.includes('npm: dev'));
  assert.strictEqual(detectConfigs(laravel).find((c) => c.label === 'npm: dev').server, 'http://localhost:5173');

  const android = tmpWorkspace({ 'settings.gradle.kts': '', 'gradlew.bat': '', gradlew: '', 'app/src/main/AndroidManifest.xml': '<manifest/>' });
  assert.ok(detectConfigs(android).some((c) => /assembleDebug/.test(c.command)));

  const spring = tmpWorkspace({ 'pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>' });
  assert.ok(detectConfigs(spring).some((c) => /spring-boot:run/.test(c.command)));

  const php = tmpWorkspace({ 'public/index.php': '<?php echo 1;' });
  assert.ok(detectConfigs(php).some((c) => c.command === 'php -S localhost:8000 -t public'));

  const py = tmpWorkspace({ 'manage.py': '', 'requirements.txt': 'django' });
  assert.ok(detectConfigs(py).some((c) => /runserver/.test(c.command)));
});
