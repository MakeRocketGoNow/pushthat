// Run before `npm run test:emulator` (as `pretest:emulator`): refuses to start when the
// emulators' ports are already taken, by another run or a leftover emulator. The CLI
// would refuse too, with a bare "port taken"; this names the port and how to find what
// holds it.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const config = JSON.parse(readFileSync(new URL('../../../firebase.json', import.meta.url), 'utf8'));
const ports = ['firestore', 'storage'].map((name) => [name, config.emulators?.[name]?.port]).filter(([, p]) => p);

const taken = [];
for (const [name, port] of ports) {
  const free = await new Promise((resolve) => {
    const server = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => server.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
  if (!free) taken.push(`${name} (${port})`);
}

if (taken.length) {
  console.error(
    `The emulator ports are in use: ${taken.join(', ')}. Another test:emulator run, or a leftover emulator, ` +
      `is holding them (\`lsof -nP -iTCP:<port> -sTCP:LISTEN\` names it). Stop it and run again.`
  );
  process.exit(1);
}
