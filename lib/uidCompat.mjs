import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentUserResolvable, pgEnv, run, which } from './procs.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function passwdWrapperPath() {
  const multiarch = {
    x64: 'x86_64-linux-gnu',
    arm64: 'aarch64-linux-gnu',
    arm: 'arm-linux-gnueabihf',
    ia32: 'i386-linux-gnu',
    ppc64: 'powerpc64le-linux-gnu',
    s390x: 's390x-linux-gnu',
  }[process.arch];
  const candidates = [
    '/usr/lib/libnss_wrapper.so',
    '/usr/lib64/libnss_wrapper.so',
    '/lib/libnss_wrapper.so',
    '/lib64/libnss_wrapper.so',
    ...(multiarch ? [
      `/usr/lib/${multiarch}/libnss_wrapper.so`,
      `/lib/${multiarch}/libnss_wrapper.so`,
    ] : []),
  ];
  return candidates.find((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  }) || null;
}

function safeLoginName(value) {
  const name = String(value || 'postgres');
  return /^[a-zA-Z_][a-zA-Z0-9_.-]{0,30}$/.test(name) ? name : 'postgres';
}

function appendPreload(env, library) {
  env.LD_PRELOAD = [library, env.LD_PRELOAD].filter(Boolean).join(':');
}

function prepareNssWrapper(cfg, pg, log, loginName, compatDir) {
  const library = passwdWrapperPath();
  if (!library) return null;
  const passwdFile = path.join(compatDir, 'passwd');
  const groupFile = path.join(compatDir, 'group');
  const uid = process.getuid();
  const gid = process.getgid();
  fs.writeFileSync(passwdFile, `${loginName}:x:${uid}:${gid}:PostgreSQL:${process.env.HOME || cfg.root}:/bin/sh\n`, { mode: 0o600 });
  fs.writeFileSync(groupFile, `${loginName}:x:${gid}:\n`, { mode: 0o600 });
  const env = pgEnv(pg);
  appendPreload(env, library);
  env.NSS_WRAPPER_PASSWD = passwdFile;
  env.NSS_WRAPPER_GROUP = groupFile;
  env.USER = loginName;
  env.LOGNAME = loginName;
  log.info('initdb', `uid ${uid} has no passwd entry — using system nss_wrapper compatibility (${library})`);
  return {
    env,
    cleanup() {
      for (const file of [passwdFile, groupFile]) {
        try { fs.unlinkSync(file); } catch {}
      }
    },
  };
}

async function prepareCompiledShim(cfg, pg, log, loginName, compatDir) {
  const compiler = which('cc') || which('gcc') || which('clang');
  if (!compiler) {
    throw new Error(
      'initdb cannot resolve this container UID in /etc/passwd, and libnss_wrapper.so is unavailable. ' +
      'A C compiler (cc/gcc/clang) is required for the bundled compatibility shim. ' +
      'Use a Node.js image with build tools or ask the host to provide libnss_wrapper.',
    );
  }

  const source = path.join(moduleDir, 'uid-passwd-shim.c');
  const output = path.join(compatDir, 'uid-passwd-shim.so');
  let rebuild = true;
  try {
    rebuild = fs.statSync(output).mtimeMs < fs.statSync(source).mtimeMs;
  } catch {}

  if (rebuild) {
    log.info('initdb', 'building bundled passwd compatibility shim for this container');
    await run(compiler, [
      '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
      '-o', output, source, '-ldl',
    ], { log, tag: 'compat', timeoutMs: 120000 });
    fs.chmodSync(output, 0o700);
  }

  const env = pgEnv(pg);
  appendPreload(env, output);
  env.PG_UID_COMPAT_NAME = loginName;
  env.USER = loginName;
  env.LOGNAME = loginName;
  log.info('initdb', `uid ${process.getuid()} has no passwd entry — using bundled passwd compatibility shim`);
  return { env, cleanup() {} };
}

export async function prepareInitdbEnvironment(cfg, pg, log) {
  const env = pgEnv(pg);
  if (process.platform !== 'linux' || currentUserResolvable()) {
    return { env, cleanup() {} };
  }

  const compatDir = path.join(cfg.dataDir, '.compat');
  fs.mkdirSync(compatDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(compatDir, 0o700); } catch {}
  const loginName = safeLoginName(cfg.osUser);
  const wrapped = prepareNssWrapper(cfg, pg, log, loginName, compatDir);
  if (wrapped) return wrapped;
  return prepareCompiledShim(cfg, pg, log, loginName, compatDir);
}
