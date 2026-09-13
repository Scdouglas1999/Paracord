import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { compile } from 'json-schema-to-typescript';
import { build } from 'esbuild';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(clientRoot, 'src/api/generated');
const source = path.join(clientRoot, '../contracts/api-contracts.json');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: generate-api-contracts.mjs [--check]');
const manifest = JSON.parse(await readFile(source, 'utf8'));
if (manifest.schema_version !== 1 || !manifest.schemas) throw new Error('Unsupported API contract manifest');
const banner = '/* eslint-disable */\n/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */\n';
const ajv = new Ajv2020({ strict: true, allErrors: false, code: { source: true, esm: true } });
// These OpenAPI numeric formats are annotations. The Rust-derived schemas carry
// explicit integer/range constraints, which Ajv validates in standalone code.
// Other unknown formats still fail strict compilation.
ajv.addFormat('int32', true);
ajv.addFormat('uint32', true);
const outputs = new Map();
const exports = {};
const declarations = [];
for (const [name, schema] of Object.entries(manifest.schemas).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`Unsafe contract name: ${name}`);
  const id = `urn:paracord:contract:${name}`;
  if (schema.$id !== id) throw new Error(`Unexpected schema ID for ${name}`);
  const definition = await compile(schema, name, {
    bannerComment: banner.trimEnd(), unknownAny: true, strictIndexSignatures: true,
    style: { singleQuote: true },
    $refOptions: { resolve: { file: false, http: false } },
  });
  outputs.set(`${name}.ts`, definition);
  ajv.addSchema(schema, id);
  exports[`is${name}`] = id;
  declarations.push(`import type { ${name} } from './${name}';`, `export declare function is${name}(data: unknown): data is ${name};`);
}
// Bundle standalone validators and their fixed runtime helpers. Browser clients
// never compile schemas or require unsafe-eval, and do not ship the Ajv compiler.
const validatorSource = standaloneCode(ajv, exports);
const bundled = await build({
  absWorkingDir: clientRoot,
  stdin: { contents: validatorSource, sourcefile: 'validators.js', resolveDir: clientRoot },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020',
  legalComments: 'none', minify: false,
});
outputs.set('validators.js', banner + bundled.outputFiles[0].text);
outputs.set('validators.d.ts', banner + declarations.join('\n') + '\n');
const expected = new Set(outputs.keys());
const existing = await readdir(target).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
for (const file of existing) {
  if (!expected.has(file)) throw new Error(`Obsolete generated contract ${file}; remove it explicitly after reviewing its consumers`);
}
if (!check) await mkdir(target, { recursive: true });
for (const [name, contents] of outputs) {
  const destination = path.join(target, name);
  if (check) {
    const actual = await readFile(destination, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (actual !== contents) throw new Error(`${path.relative(clientRoot, destination)} is stale; run npm run contracts:generate`);
  } else await writeFile(destination, contents);
}
console.log(`${check ? 'Verified' : 'Generated'} ${Object.keys(manifest.schemas).length} Rust-derived API types and standalone validators.`);
