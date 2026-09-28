// Local replacement for the release workflow (no GitHub Actions minutes needed).
// Usage: npm run release 0.3.0 [-- --notes-file notes.md]
// Bumps versions, tests, builds, zips dist/, commits, tags, pushes and creates the GitHub Release via `gh`.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';

const [version, ...rest] = process.argv.slice(2);
const notesIdx = rest.indexOf('--notes-file');
const notesFile = notesIdx > -1 ? rest[notesIdx + 1] : null;

const die = (msg) => { console.error(`release: ${msg}`); process.exit(1); };
// No shells anywhere (they split args like "Release v1.0.0" and trigger DEP0190). npm is a
// .cmd on Windows, so run its JS entry (npm_execpath, set by `npm run`) with node directly.
const run = (cmd, args, opts = {}) => {
  if (cmd === 'npm') {
    if (!process.env.npm_execpath) die('run this via `npm run release`');
    [cmd, args] = [process.execPath, [process.env.npm_execpath, ...args]];
  }
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
};
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) die('give a version like 0.3.0');
const tag = `v${version}`;
const zip = `tabsync-${tag}.zip`;

try { out('gh', ['auth', 'status']); } catch { die('gh CLI missing or not logged in (winget install GitHub.cli, then gh auth login)'); }
if (out('git', ['status', '--porcelain', '--untracked-files=no'])) die('commit or stash your changes first');
if (out('git', ['tag', '-l', tag])) die(`tag ${tag} already exists`);

run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']); // package.json + lock
const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
manifest.version = version;
writeFileSync('public/manifest.json', JSON.stringify(manifest, null, 2) + '\n');

run('npm', ['test']);
run('npm', ['run', 'build']);

// Windows' built-in bsdtar writes zips with forward slashes; elsewhere use zip.
rmSync(zip, { force: true });
if (process.platform === 'win32') run(`${process.env.SystemRoot}\\System32\\tar.exe`, ['-a', '-c', '-f', `../${zip}`, ...readdirSync('dist')], { cwd: 'dist' });
else run('zip', ['-qr', `../${zip}`, '.'], { cwd: 'dist' });

run('git', ['commit', '-m', `Release ${tag}`, '--', 'package.json', 'package-lock.json', 'public/manifest.json']);
run('git', ['tag', tag]);
run('git', ['push', '--atomic', 'origin', 'HEAD', tag]);
run('gh', ['release', 'create', tag, zip, '--title', `TabSync ${tag}`, ...(notesFile ? ['--notes-file', notesFile] : ['--generate-notes'])]);

rmSync(zip);
console.log(`\nReleased ${tag}`);
