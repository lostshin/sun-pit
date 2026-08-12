import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const fromRoot = (path) => new URL(path, root);

function fail(message) {
  console.error(`Validation failed: ${message}`);
  process.exit(1);
}

function requireFile(path) {
  if (!existsSync(fromRoot(path))) {
    fail(`missing referenced file: ${path}`);
  }
}

function readPngSize(path) {
  const bytes = readFileSync(fromRoot(path));
  const pngSignature = '89504e470d0a1a0a';

  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== pngSignature) {
    fail(`${path} is not a valid PNG file`);
  }

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(fromRoot('manifest.json'), 'utf8'));
} catch (error) {
  fail(`manifest.json is invalid JSON: ${error.message}`);
}

if (manifest.manifest_version !== 3) {
  fail('manifest_version must be 3');
}

if (!(manifest.permissions || []).includes('nativeMessaging')) {
  fail('nativeMessaging permission is required for the local Vault helper');
}

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  fail(`unexpected version format: ${manifest.version}`);
}
if (typeof manifest.description !== 'string' || manifest.description.length > 132) {
  fail('manifest description must be a string no longer than 132 characters');
}

const referencedFiles = new Set([
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  'native/host.rb',
  'native/install-host.sh',
  'native/uninstall-host.sh',
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((script) => script.js || [])
].filter(Boolean));

for (const path of referencedFiles) {
  requireFile(path);
}

const popupHtml = readFileSync(fromRoot('popup/popup.html'), 'utf8');
const popupScript = readFileSync(fromRoot('popup/popup.js'), 'utf8');
for (const match of popupScript.matchAll(/getElementById\('([^']+)'\)/g)) {
  if (!popupHtml.includes(`id="${match[1]}"`)) {
    fail(`popup/popup.js references missing element id: ${match[1]}`);
  }
}

for (const size of ['16', '32', '48', '128']) {
  const path = manifest.icons?.[size];
  if (!path) fail(`manifest icon ${size}px is not configured`);

  const dimensions = readPngSize(path);
  if (dimensions.width !== Number(size) || dimensions.height !== Number(size)) {
    fail(`${path} must be ${size}x${size}, received ${dimensions.width}x${dimensions.height}`);
  }
}

const storeAssets = {
  'assets/store/screenshot-overview.png': { width: 1280, height: 800 },
  'assets/store/small-promo.png': { width: 440, height: 280 }
};

for (const [path, expected] of Object.entries(storeAssets)) {
  requireFile(path);
  const dimensions = readPngSize(path);
  if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
    fail(`${path} must be ${expected.width}x${expected.height}, received ${dimensions.width}x${dimensions.height}`);
  }
}

for (const path of ['INSTALL.md', 'LICENSE', 'PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
  requireFile(path);
}

const broadHostPermissions = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']);
for (const permission of manifest.host_permissions || []) {
  if (broadHostPermissions.has(permission)) {
    fail(`broad host permission is not allowed: ${permission}`);
  }
}

const javascriptFiles = [
  'background.js',
  ...readdirSync(fromRoot('providers')).filter((file) => file.endsWith('.js')).map((file) => join('providers', file)),
  ...readdirSync(fromRoot('shared')).filter((file) => file.endsWith('.js')).map((file) => join('shared', file)),
  ...readdirSync(fromRoot('content')).filter((file) => file.endsWith('.js')).map((file) => join('content', file)),
  ...readdirSync(fromRoot('popup')).filter((file) => file.endsWith('.js')).map((file) => join('popup', file))
];

for (const path of javascriptFiles) {
  const source = readFileSync(fromRoot(path), 'utf8');
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) {
    fail(`${path} must not evaluate string-based code`);
  }
  execFileSync(process.execPath, ['--check', fromRoot(path).pathname], { stdio: 'inherit' });
}
if (/<script\b[^>]*\bsrc=["']https?:/i.test(popupHtml)) {
  fail('popup must not load remote scripts');
}

for (const path of ['native/host.rb', 'native/install-host.sh', 'native/uninstall-host.sh']) {
  if ((statSync(fromRoot(path)).mode & 0o111) === 0) fail(`${path} must be executable`);
}
execFileSync('/usr/bin/ruby', ['-c', fromRoot('native/host.rb').pathname], { stdio: 'inherit' });
for (const path of ['native/install-host.sh', 'native/uninstall-host.sh']) {
  execFileSync('zsh', ['-n', fromRoot(path).pathname], { stdio: 'inherit' });
}

console.log(`Validated Manifest V3 extension v${manifest.version}: ${javascriptFiles.length} scripts, ${referencedFiles.size} referenced assets, ${Object.keys(storeAssets).length} store assets.`);
