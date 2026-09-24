import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Every `invoke('name')` in the renderer must name a command the desktop shell
 * actually registered.
 *
 * This exists because of a silent stream. `client/src/lib/systemAudioCapture.ts`
 * called `invoke('start_system_audio_capture')`, `invoke('stop_...')` and
 * `invoke('set_system_audio_capture_enabled')`; none of the three appeared in
 * `generate_handler!`, so every one of them rejected with "command not found" at
 * runtime. Nothing in the type system connects a string in TypeScript to a
 * function in Rust, no test covered the seam, and the module sat there — unused
 * and un-invokable — through a release. This test is that missing seam: it reads
 * the handler list out of `lib.rs` and holds the renderer to it.
 */

/**
 * Walk up from the working directory to the `client/` package root. The jsdom
 * environment rewrites `import.meta.url` to an http URL, so the file's own
 * location is not usable here.
 */
function clientRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, 'src-tauri', 'src', 'lib.rs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate the client package root');
    dir = parent;
  }
}

const root = clientRoot();
const clientSrc = join(root, 'src');
const libRs = join(root, 'src-tauri', 'src', 'lib.rs');

/** Command names passed to `tauri::generate_handler!` in `lib.rs`. */
function registeredCommands(): Set<string> {
  const source = readFileSync(libRs, 'utf8');
  const block = /tauri::generate_handler!\[(.*?)\]/s.exec(source);
  if (!block) throw new Error(`no generate_handler! block found in ${libRs}`);
  return new Set(
    block[1]
      .replace(/\/\/[^\n]*/g, '') // strip trailing and standalone comments
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.split('::').pop() as string),
  );
}

/** Every renderer source file, tests excluded. */
function rendererSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...rendererSources(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(path);
  }
  return out;
}

/**
 * `invoke('name')` and the two engine wrappers that forward to it
 * (`invokeOwned` / `invokeCleanup`) with a literal command name. Calls built
 * from a variable cannot be checked here and are skipped by construction.
 */
const INVOKE_LITERAL = /\binvoke(?:Owned|Cleanup)?\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g;

describe('desktop command registry', () => {
  it('registers every command the renderer invokes by name', () => {
    const registered = registeredCommands();
    expect(registered.size).toBeGreaterThan(20);

    const unregistered: Array<{ command: string; file: string }> = [];
    for (const file of rendererSources(clientSrc)) {
      const contents = readFileSync(file, 'utf8');
      for (const match of contents.matchAll(INVOKE_LITERAL)) {
        const command = match[1];
        if (!registered.has(command)) {
          unregistered.push({ command, file: file.slice(clientSrc.length + 1) });
        }
      }
    }

    expect(
      unregistered,
      'these commands are invoked by the renderer but are missing from ' +
        'tauri::generate_handler! in client/src-tauri/src/lib.rs, so they reject ' +
        'with "command not found" at runtime',
    ).toEqual([]);
  });

  it('recognizes an unregistered command as a failure', () => {
    // Guards the guard: if the handler list ever stopped parsing, the test above
    // would pass vacuously against an empty set.
    const registered = registeredCommands();
    expect(registered.has('start_voice_session')).toBe(true);
    expect(registered.has('start_system_audio_capture')).toBe(false);
  });
});
