import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {packager} from '@electron/packager';
import {flipFuses, FuseVersion, FuseV1Options} from '@electron/fuses';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const iconset = path.join(root, 'desktop/Folio.iconset');
const cache = path.join(root, '.cache');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const arch = process.env.FOLIO_ARCH || process.arch;
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('Build Folio on macOS for arm64 or x64.');

await fs.mkdir(iconset, {recursive: true});
await fs.mkdir(release, {recursive: true});
await fs.mkdir(path.join(cache, 'swift'), {recursive: true});
console.log('Drawing the Folio icon…');
const master = path.join(iconset, 'icon_512x512@2x.png');
await exec('/usr/bin/swift', ['-module-cache-path', path.join(cache, 'swift'), path.join(root, 'desktop/make-icon.swift'), master]);
for (const size of [16, 32, 128, 256, 512]) {
  await exec('/usr/bin/sips', ['-z', String(size), String(size), master, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
  if (size !== 512) await exec('/usr/bin/sips', ['-z', String(size * 2), String(size * 2), master, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
}
const icon = path.join(root, 'desktop/Folio.icns');
// Encode PNG representations directly, avoiding Icon Services/XPC during build.
const representations = [['icp4', '16x16'], ['ic11', '16x16@2x'], ['icp5', '32x32'], ['ic12', '32x32@2x'], ['ic07', '128x128'], ['ic13', '128x128@2x'], ['ic08', '256x256'], ['ic14', '256x256@2x'], ['ic09', '512x512'], ['ic10', '512x512@2x']];
const chunks = [];
for (const [type, size] of representations) {
  const png = await fs.readFile(path.join(iconset, `icon_${size}.png`));
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
}
const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(chunks.reduce((size, bytes) => size + bytes.length, 8), 4);
await fs.writeFile(icon, Buffer.concat([header, ...chunks]));

console.log(`Packaging Folio for ${arch}…`);
const ignore = [
  /^\/(?:\.git|\.cache|release|tests|docs|node_modules)(?:\/|$)/,
  /^\/(?:README\.md|THIRD_PARTY_NOTICES\.md|server\.py|Start Folio\.command|package-lock\.json|\.gitignore)$/,
  /^\/desktop\/(?:build\.mjs|make-icon\.swift|Folio\.icns|Folio\.iconset)(?:\/|$)/
];
if (!process.argv.includes('--local-font')) ignore.push(/^\/dist\/assets\/fonts\//);
const [folder] = await packager({
  dir: root, name: 'Folio', appBundleId: 'ad.christian.folio', appCategoryType: 'public.app-category.productivity',
  platform: 'darwin', arch, out: release, overwrite: true, asar: true, prune: true,
  electronVersion: manifest.devDependencies.electron, icon, ignore,
  download: {cacheRoot: path.join(cache, 'electron')},
  extendInfo: {
    NSHumanReadableCopyright: 'Folio',
    CFBundleDocumentTypes: [{CFBundleTypeName: 'PDF document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['com.adobe.pdf']}],
    NSHighResolutionCapable: true
  }
});
const bundle = path.join(folder, 'Folio.app');
await flipFuses(bundle, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true
});
// A local ad-hoc signature permits clean launch on this Mac. Public distribution
// should use the owner's Developer ID and notarization instead.
await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
console.log(`Built ${bundle}`);

if (!process.argv.includes('--no-archive')) {
  const zip = path.join(release, `Folio-${manifest.version}-${arch}.zip`);
  await exec('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip]);
  console.log(`Built ${zip}`);
}

if (process.argv.includes('--dmg')) {
  const staging = path.join(release, '.dmg');
  await fs.rm(staging, {recursive: true, force: true});
  await fs.mkdir(staging);
  await fs.cp(bundle, path.join(staging, 'Folio.app'), {recursive: true});
  await fs.symlink('/Applications', path.join(staging, 'Applications'));
  const dmg = path.join(release, `Folio-${manifest.version}-${arch}.dmg`);
  console.log('Creating the disk image…');
  try {
    await exec('/usr/bin/hdiutil', ['create', '-volname', 'Folio', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg], {maxBuffer: 1024 * 1024});
  } finally { await fs.rm(staging, {recursive: true, force: true}); }
  console.log(`Built ${dmg}`);
}
