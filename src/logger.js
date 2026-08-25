// Minimal leveled logger: every line is prefixed with a level and ISO
// timestamp so unattended container runs stay diagnosable after the fact.
// Set LOG_LEVEL=debug|info|warn|error to control verbosity (default info).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LOG_LEVEL = 'info';

const configuredLevel = (process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL).toLowerCase();
const minLevel = LEVELS[configuredLevel] ?? LEVELS[DEFAULT_LOG_LEVEL];

function write(level, args) {
    if (LEVELS[level] < minLevel) return;
    const prefix = `[${level.toUpperCase()}] ${new Date().toISOString()}`;
    const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    target(prefix, ...args);
}

module.exports = {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
};
