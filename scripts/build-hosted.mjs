import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
await build({ entryPoints: ['src/hosted/client.js'], outfile: 'dist/public/modules/hosted.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['./hosted-exports.js'] });
await build({ entryPoints: ['src/hosted/exports.js'], outfile: 'dist/public/modules/hosted-exports.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
await writeFile('dist/public/runtime.js', 'window.SIGNAL404_HOSTED = true;\n');
const path = 'dist/public/index.html';
let html = await readFile(path, 'utf8');
html = html.replaceAll('Local workspace', 'Browser workspace').replaceAll('Local edition', 'Hosted edition').replaceAll('Local engine', 'Serverless engine').replace('Audit history and reports are saved on this computer.', 'Audits are saved in this browser. Keep this tab open while scanning. Clearing site data deletes saved audits; export reports to keep a copy.');
await writeFile(path, html);
