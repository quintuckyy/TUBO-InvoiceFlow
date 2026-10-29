// Minimal structured (JSON-lines) logger. In production these lines are shipped to a
// log aggregator (ELK, Loki, CloudWatch...) and searched by fields like invoiceId / requestId.

function write(level, base, msg, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function createLogger(base = {}) {
  return {
    info: (msg, fields) => write('info', base, msg, fields),
    warn: (msg, fields) => write('warn', base, msg, fields),
    error: (msg, fields) => write('error', base, msg, fields),
    child: (extra) => createLogger({ ...base, ...extra }),
  };
}

export const logger = createLogger();
