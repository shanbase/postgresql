// The @embedded-postgres npm packages ship Postgres' shared-library symlinks
// flattened away; their postinstall (hydrate-symlinks.js) recreates them from
// native/pg-symlinks.json — but Altare's npm blocks install scripts, so we do
// it ourselves at boot. Also reports the lib dir for LD_LIBRARY_PATH.
import fs from 'node:fs';
import path from 'node:path';

/** native/lib sits next to native/bin. */
export function nativeLibDir(binDir) {
  const lib = path.join(path.dirname(binDir), 'lib');
  try { return fs.statSync(lib).isDirectory() ? lib : null; } catch { return null; }
}

/**
 * Recreate the bundled symlinks described by native/pg-symlinks.json.
 * The JSON paths are relative to the PACKAGE ROOT (e.g.
 * node_modules/@embedded-postgres/linux-x64), not to native/.
 * Returns the lib dir (for LD_LIBRARY_PATH) or null when not applicable.
 */
export function prepareNativeLibs(binDir, log) {
  if (process.platform === 'win32') return null;
  const pkgRoot = path.dirname(path.dirname(binDir)); // .../@embedded-postgres/<platform>
  const libDir = nativeLibDir(binDir);
  if (!libDir) return null;

  const manifest = path.join(pkgRoot, 'native', 'pg-symlinks.json');
  if (!fs.existsSync(manifest)) {
    log?.debug('native', 'no pg-symlinks.json manifest — assuming libs are intact');
    return libDir;
  }

  let links;
  try {
    links = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (err) {
    log?.warn('native', `could not parse pg-symlinks.json: ${err.message}`);
    return libDir;
  }
  if (!Array.isArray(links)) return libDir;

  let created = 0, skipped = 0, failed = 0;
  for (const { source, target } of links) {
    if (!source || !target) continue;
    const sourcePath = path.resolve(pkgRoot, source);
    const targetPath = path.resolve(pkgRoot, target);
    const relativeSource = path.relative(path.dirname(targetPath), sourcePath);
    try {
      const lst = fs.lstatSync(targetPath, { throwIfNoEntry: false });
      if (lst?.isSymbolicLink()) { skipped += 1; continue; }
      if (lst) fs.unlinkSync(targetPath); // stale placeholder file
      fs.symlinkSync(relativeSource, targetPath);
      created += 1;
    } catch (err) {
      failed += 1;
      log?.debug('native', `symlink ${target} failed: ${err.message}`);
    }
  }
  log?.info('native', `hydrated ${created} shared-library symlinks (${skipped} present, ${failed} failed) in ${libDir}`);
  return libDir;
}
