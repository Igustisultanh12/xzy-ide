// Bootstraps Monaco's web worker from the app:// origin (same origin as the page).
self.MonacoEnvironment = { baseUrl: 'app://xzy/node_modules/monaco-editor/min/' };
importScripts('app://xzy/node_modules/monaco-editor/min/vs/base/worker/workerMain.js');
