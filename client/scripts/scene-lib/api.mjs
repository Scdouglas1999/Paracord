// The REST and realtime surface the scene driver speaks, as the cast's own
// accounts. Every call carries the account's bearer token; nothing here reaches
// into the database or seeds anything the product's own API would not accept.

export class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 600));
    this.status = status;
    this.body = body;
  }
}

export function createApi(base) {
  const root = base.replace(/\/+$/, '');
  /**
   * People whose session this driver may renew, by their current token. A
   * holder outlives an access token (about 40 minutes), and the relay probes
   * must not read an expired token's 401 as "nobody is in the room".
   */
  const renewable = new Map();

  async function request(token, method, path, body, { raw = false, headers = {} } = {}) {
    const url = path.startsWith('http') ? path : `${root}${path.startsWith('/api/') ? '' : '/api/v1'}${path}`;
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    // One short retry on 429 so a burst against a stricter instance (pc-lab)
    // does not fail the whole seed; anything else fails loudly.
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, init);
      if (response.status === 401 && token && !renewed && renewable.has(token)) {
        const person = renewable.get(token);
        renewable.delete(token);
        const session = await api.account(person, { likelyExists: true });
        person.token = session.token;
        renewable.set(person.token, person);
        init.headers.Authorization = `Bearer ${person.token}`;
        renewed = true;
        continue;
      }
      if (response.status === 429 && attempt < 5) {
        const wait = Number(response.headers.get('retry-after') ?? '1');
        await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, wait)) * 1000));
        continue;
      }
      if (raw) return response;
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      if (!response.ok) throw new ApiError(method, path, response.status, parsed);
      return parsed;
    }
  }

  const api = {
    base: root,
    request,
    /** Sign `person` in again when their token expires (they need `email` and `password`). */
    keepSignedIn(person) {
      renewable.set(person.token, person);
    },
    health: () => fetch(`${root}/api/v1/health`).then(r => r.ok).catch(() => false),

    /**
     * Sign in, or register when the account does not exist yet.
     *
     * Every refused register or login counts against this address in the
     * instance's auth guard, and five lock it out for a while — so the call
     * that is most likely to succeed goes first (`likelyExists`, from the last
     * run's scene.json), and a run costs at most one refusal.
     */
    async account({ username, email, password }, { likelyExists = false } = {}) {
      const post = (path, body) => fetch(`${root}/api/v1/auth/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const attempts = likelyExists
        ? [['login', { email, password }, false], ['register', { email, username, password }, true]]
        : [['register', { email, username, password }, true], ['login', { email, password }, false]];
      const refusals = [];
      for (const [path, body, created] of attempts) {
        const response = await post(path, body);
        if (response.ok) {
          const parsed = await response.json();
          return { id: String(parsed.user.id), token: parsed.token, created };
        }
        refusals.push(`${path} ${response.status} ${(await response.text().catch(() => '')).slice(0, 160)}`);
        if (response.status === 429) break;
      }
      throw new Error(
        `cannot sign in or register ${username} <${email}>: ${refusals.join('; ')}. ` +
        'A 429 is the auth guard cooling down after refused attempts (wait a minute); ' +
        'if the name is taken by someone else on this instance, rerun with --tag <suffix>.',
      );
    },

    /** Upload a PNG as a message attachment; resolves to the pending attachment id. */
    async uploadAttachment(token, channelId, filename, bytes) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'image/png' }), filename);
      const body = await request(token, 'POST', `/channels/${channelId}/attachments`, form);
      return String(body.id);
    },

    async uploadMultipart(token, path, field, filename, bytes) {
      const form = new FormData();
      form.append(field, new Blob([bytes], { type: 'image/png' }), filename);
      return request(token, 'POST', path, form);
    },
  };
  return api;
}

/**
 * Hold a realtime stream open for an account, the way the app does: a
 * single-use ticket, then the SSE event stream. Attaching is what marks a
 * person online, so this is how Jeremy, Luke and Eric are "around" without a
 * browser each. `onEvent(name, data)` receives every gateway dispatch
 * (READY, VOICE_STATE_UPDATE, …). Reconnects until `close()`.
 */
export function holdRealtime(api, token, { onEvent = () => {}, onState = () => {} } = {}) {
  let closed = false;
  let controller = null;

  async function once() {
    const { ticket } = await api.request(token, 'POST', '/stream/ticket', {});
    controller = new AbortController();
    const response = await fetch(`${api.base}/api/v2/rt/events?ticket=${encodeURIComponent(ticket)}`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`realtime stream: ${response.status}`);
    onState('open');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        const name = payload.t ?? payload.type ?? payload.event ?? null;
        onEvent(name, payload.d ?? payload.data ?? payload);
      }
    }
  }

  (async function loop() {
    while (!closed) {
      try { await once(); } catch (error) { if (!closed) onState(`error: ${error.message}`); }
      if (!closed) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  })();

  return { close() { closed = true; controller?.abort(); } };
}
