import { chmod, cp, mkdir } from 'node:fs/promises';

await mkdir(new URL('../dist/public/', import.meta.url), { recursive: true });
await cp(new URL('../src/public/', import.meta.url), new URL('../dist/public/', import.meta.url), {
  recursive: true,
});
await chmod(new URL('../dist/cli.js', import.meta.url), 0o755);
