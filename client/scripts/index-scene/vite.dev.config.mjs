// A dev server for the working tree, for `index-scene.mjs --ui`.
//
//   cd client
//   VITE_DEV_PROXY_TARGET=http://127.0.0.1:18420 VITE_DEV_HMR=false \
//     npx vite --config scripts/index-scene/vite.dev.config.mjs --port 4693 --host 127.0.0.1
//   node scripts/index-scene.mjs --ui http://127.0.0.1:4693
//
// It is the app's own vite.config.ts plus one thing: Vite may serve files from
// outside the project root. In a worktree whose `node_modules` is a symlink to
// another worktree's (the Index worktree's is), the fonts resolve outside the
// root and Vite answers 403, so every screenshot would be set in a fallback
// face. Loopback only, a throwaway server: the guard is not needed.
//
// What a dev server cannot do (index-scene.mjs header): the Direct messages. Their encryption
// identity is bound to the origin it was enrolled from, the instance's own.

import { mergeConfig } from 'vite';
import base from '../../vite.config.ts';

export default env => mergeConfig(typeof base === 'function' ? base(env) : base, {
  server: { fs: { strict: false } },
});
