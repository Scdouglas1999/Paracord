import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EmbedBuilder,
  InteractionResponseBuilder,
} from '../dist/builders.js';
import { ParacordGatewayClient } from '../dist/gateway.js';
import { ParacordRestClient } from '../dist/rest.js';
import { SlashCommandBuilder } from '../dist/builders.js';

class FakeWs {
  constructor() {
    this.readyState = 1;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }

  emitOpen() {
    if (this.onopen) this.onopen();
  }

  emitMessage(payload) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
  }
}

test('builders create command/embed/interaction payloads', () => {
  const command = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Ping command')
    .addStringOption('target', 'target user')
    .build();
  assert.equal(command.name, 'ping');
  assert.equal(command.options.length, 1);

  const embed = new EmbedBuilder().setTitle('Hello').setDescription('World').build();
  assert.equal(embed.title, 'Hello');

  const interaction = InteractionResponseBuilder.message('Pong', true);
  assert.equal(interaction.type, 4);
  assert.equal(interaction.data.flags, 64);
});

test('rest client retries on 429 and succeeds', async () => {
  const calls = [];
  const fetchImpl = async () => {
    calls.push(Date.now());
    if (calls.length === 1) {
      return new Response(JSON.stringify({ retry_after: 0.001 }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = new ParacordRestClient({
    baseUrl: 'http://localhost:8080/api/v1',
    token: 'bot',
    fetchImpl,
  });

  const commands = await client.listGlobalCommands('app');
  assert.ok(Array.isArray(commands));
  assert.equal(calls.length, 2);
});

test('gateway identifies after HELLO and resolves on READY', async () => {
  const ws = new FakeWs();
  const gateway = new ParacordGatewayClient({
    url: 'ws://localhost:8080/gateway',
    token: 'bot',
    intents: 513,
    wsFactory: () => ws,
  });

  const connected = gateway.connect();
  ws.emitOpen();
  ws.emitMessage({ op: 10, d: { heartbeat_interval: 60000 } });
  ws.emitMessage({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-1' } });
  await connected;

  const identifyPayload = ws.sent.map((item) => JSON.parse(item)).find((item) => item.op === 2);
  assert.ok(identifyPayload);
  assert.equal(identifyPayload.d.token, 'bot');
  assert.equal(identifyPayload.d.intents, 513);
  gateway.close();
});
