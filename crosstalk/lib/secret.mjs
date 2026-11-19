// Read a secret without it ever touching argv or shell history.
// From a terminal: hidden prompt (nothing echoes). From a pipe: the whole of stdin.

const clean = (s) =>
  String(s)
    .replace(/\x1b\[20[01]~/g, '') // bracketed-paste markers, if a terminal sends them
    .trim();

export async function readSecret(prompt = 'Token: ') {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let s = '';
    for await (const chunk of stdin) s += chunk;
    return clean(s);
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let s = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      const value = clean(s);
      process.stderr.write(value ? `\n(received ${value.length} characters)\n` : '\n');
      resolve(value);
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
        else s += ch;
      }
    }
    stdin.on('data', onData);
  });
}
