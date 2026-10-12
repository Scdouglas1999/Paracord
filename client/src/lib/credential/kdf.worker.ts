/// <reference lib="webworker" />

// One scrypt per worker (spec §3.2): `derive.ts` spawns this, posts one
// request, and terminates it as soon as the answer (or an error) arrives, so
// the 128 MiB scrypt buffer goes back to the system.
import { handleKdfRequest } from './kdfCore';

self.addEventListener('message', (event: MessageEvent) => {
  void handleKdfRequest(event.data).then(({ response, transfer }) => {
    self.postMessage(response, { transfer });
  });
});
