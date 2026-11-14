// Terminal + file logger. Everything the system does is visible in the
// terminal with timestamps, levels and component tags; a copy is appended
// to logs/veyra-postgres.log for post-mortems.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const C = {
  debug: NO_COLOR ? '' : '\x1b[90m',
  info: NO_COLOR ? '' : '\x1b[36m',
  warn: NO_COLOR ? '' : '\x1b[33m',
  error: NO_COLOR ? '' : '\x1b[31m',
  tag: NO_COLOR ? '' : '\x1b[35m',
  dim: NO_COLOR ? '' : '\x1b[2m',
  reset: NO_COLOR ? '' : '\x1b[0m',
};

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function createLogger({ level = 'info', logDir = null } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  let stream = null;
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    stream = fs.createWriteStream(path.join(logDir, 'veyra-postgres.log'), { flags: 'a' });
  }

  function write(levelName, tag, args) {
    if (LEVELS[levelName] < threshold) return;
    const message = args
      .map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ');
    const line = `${stamp()} ${levelName.toUpperCase().padEnd(5)} ${C.tag}[${tag}]${C.reset} ${message}`;
    const plain = `${stamp()} ${levelName.toUpperCase().padEnd(5)} [${tag}] ${message}`;
    if (levelName === 'error' || levelName === 'warn') console.error(line);
    else console.log(line);
    if (stream) stream.write(plain + '\n');
  }

  const api = {
    debug: (tag, ...a) => write('debug', tag, a),
    info: (tag, ...a) => write('info', tag, a),
    warn: (tag, ...a) => write('warn', tag, a),
    error: (tag, ...a) => write('error', tag, a),
    /** Pipe a child process' stdout/stderr into the log, one entry per line. */
    pipe(tag, readable, lvl = 'info') {
      if (!readable) return;
      const rl = readline.createInterface({ input: readable, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (line.trim() === '') return;
        write(lvl, tag, [line]);
      });
    },
    close() {
      stream?.end();
    },
  };
  return api;
}
