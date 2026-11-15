// Runs the game server and the Vite client together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  ['server', ['run', 'dev', '-w', '@benzina/server']],
  ['client', ['run', 'dev', '-w', '@benzina/client']],
].map(([name, args]) => {
  const p = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => `[${name}] ${l}`)
      .join('\n') + '\n';
  p.stdout.on('data', (d) => process.stdout.write(prefix(d)));
  p.stderr.on('data', (d) => process.stderr.write(prefix(d)));
  p.on('exit', (code) => {
    console.log(`[${name}] exited (${code})`);
    shutdown();
  });
  return p;
});

function shutdown() {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
