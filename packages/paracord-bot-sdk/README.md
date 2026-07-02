# @paracord/bot-sdk

Official TypeScript SDK for Paracord bots.

## Features

- REST client with built-in rate-limit retry handling
- WebSocket gateway client (HELLO/IDENTIFY/HEARTBEAT/RESUME)
- Slash command and embed builders
- High-level `BotClient` with interaction command routing

## Quick Example

```ts
import { BotClient, SlashCommandBuilder, InteractionResponseBuilder } from '@paracord/bot-sdk';

const bot = new BotClient({
  token: process.env.PARACORD_BOT_TOKEN!,
  applicationId: process.env.PARACORD_APP_ID!,
  restBaseUrl: 'http://localhost:8090/api/v1',
  gatewayUrl: 'ws://localhost:8090/gateway',
});

bot.command(
  new SlashCommandBuilder().setName('ping').setDescription('health check').build(),
  async (ctx) => {
    await ctx.reply(InteractionResponseBuilder.message('Pong!'));
  },
);

await bot.start({ syncCommands: true });
```
