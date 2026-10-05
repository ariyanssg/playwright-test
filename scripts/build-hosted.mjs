import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
await build({ entryPoints: ['src/hosted/client.js'], outfile: 'dist/public/modules/hosted.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, external: ['./hosted-exports.js'] });
await build({ entryPoints: ['src/hosted/exports.js'], outfile: 'dist/public/modules/hosted-exports.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
// The page reads this flag and adjusts its own wording (storage, credentials, desktop-only
// features), so the HTML is no longer rewritten here by string replacement.
await writeFile('dist/public/runtime.js', 'window.SIGNAL404_HOSTED = true;\n');
