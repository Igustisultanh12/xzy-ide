'use strict';

/**
 * Settings stored in the user's profile folder. The TokenomixAI API key is encrypted with
 * Windows DPAPI through Electron safeStorage when available.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.tokenomixai.com/v1',
  defaultModel: '',
  defaultMode: 'ask',
  theme: 'dark',
  fontSize: 14,
  wordWrap: 'off',
  maxSteps: 80,
  maxTokens: 16384,
  customInstructions: '',
  autoSave: false,
  recentFolders: [],
  lastFolder: '',
};

class Settings {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'settings.json');
    this.safeStorage = safeStorage;
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw };
      if (raw.apiKeyEnc) this.data.apiKey = this.decrypt(raw.apiKeyEnc);
      delete this.data.apiKeyEnc;
    } catch { /* first run */ }
  }

  canEncrypt() {
    try { return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable()); } catch { return false; }
  }

  encrypt(text) {
    if (!text) return '';
    if (this.canEncrypt()) return 'enc:' + this.safeStorage.encryptString(text).toString('base64');
    return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
  }

  decrypt(value) {
    try {
      if (value.startsWith('enc:') && this.canEncrypt()) return this.safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
      if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
    } catch { /* unreadable on this machine */ }
    return '';
  }

  get(key) { return this.data[key]; }

  all() { return { ...this.data }; }

  /** Settings for the renderer: the key itself never leaves the main process. */
  public() {
    const { apiKey, ...rest } = this.data;
    return { ...rest, hasApiKey: !!apiKey, apiKeyHint: apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : '' };
  }

  set(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS)) continue;
      if (k === 'apiKey' && typeof v === 'string' && v.includes('...')) continue; // masked value sent back
      this.data[k] = v;
    }
    this.data.fontSize = Math.min(Math.max(Number(this.data.fontSize) || 14, 10), 28);
    this.data.maxSteps = Math.min(Math.max(Number(this.data.maxSteps) || 80, 5), 500);
    this.save();
    return this.public();
  }

  addRecent(folder) {
    const list = [folder, ...this.data.recentFolders.filter((f) => f !== folder)].slice(0, 12);
    this.data.recentFolders = list;
    this.data.lastFolder = folder;
    this.save();
  }

  save() {
    const { apiKey, ...rest } = this.data;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...rest, apiKeyEnc: this.encrypt(apiKey) }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS };
