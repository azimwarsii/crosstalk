// A stand-in agent CLI for tests: reads the prompt on stdin, prints a reply.
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const msg = (process.env.CROSSTALK_MESSAGE || '').replace(/@/g, '');
  const sawRules = input.includes('NO_REPLY') ? 'rules' : 'no-rules';
  process.stdout.write(`mock ${process.env.CROSSTALK_AGENT} heard "${msg}" tier=${process.env.CROSSTALK_TIER} ${sawRules}`);
});
