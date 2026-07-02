# Bot Development Quickstart

This guide covers the current Paracord bot flow end-to-end:

1. Create a bot application in `Developer Portal` (`/app/developers`).
2. Copy the generated bot token immediately (it is only shown on creation or regeneration).
3. Install the bot into a server:
   - Use the install link from `Developer Portal`, or
   - Open `Server Settings -> Bots` and add the application by ID.
4. Register slash commands for the application.
5. Connect the bot gateway client or poll your own integration layer for
   interactions.
6. Respond to interactions with the callback/followup APIs.
7. Call APIs as the bot using `Authorization: Bot <token>`.

## OAuth-style install link

Paracord supports an authorization page at:

`/app/oauth2/authorize?client_id=<APP_ID>&permissions=<PERMISSIONS>`

Optional query params:

- `redirect_uri`: must match the application redirect URI exactly.
- `state`: opaque value returned to the redirect target.

After authorization, Paracord can redirect back with:

- `authorized=true`
- `application_id=<APP_ID>`
- `guild_id=<GUILD_ID>`
- `state=<STATE>` (if provided)

## Bot authentication

Use the bot token in the standard HTTP `Authorization` header:

```http
Authorization: Bot <TOKEN>
```

Bot tokens are stored hashed server-side and validated against `bot_applications`.

## Slash command lifecycle

Register global commands:

```http
PUT /api/v1/applications/<APP_ID>/commands
Authorization: Bot <TOKEN>
Content-Type: application/json
```

Register guild-scoped commands:

```http
PUT /api/v1/applications/<APP_ID>/guilds/<GUILD_ID>/commands
Authorization: Bot <TOKEN>
Content-Type: application/json
```

Installed command discovery for users is exposed at:

```http
GET /api/v1/guilds/<GUILD_ID>/commands
```

When a user invokes a command, Paracord creates an interaction and dispatches an
`INTERACTION_CREATE` gateway event to the bot. The bot responds with the
interaction token:

```http
POST /api/v1/interactions/<INTERACTION_ID>/<TOKEN>/callback
Content-Type: application/json

{ "type": 4, "data": { "content": "Pong!" } }
```

Followup and original-response APIs are also available:

- `PATCH /api/v1/interactions/<APP_ID>/<TOKEN>/messages/@original`
- `DELETE /api/v1/interactions/<APP_ID>/<TOKEN>/messages/@original`
- `POST /api/v1/interactions/<APP_ID>/<TOKEN>/followup`

## TypeScript SDK

The SDK package is in `packages/paracord-bot-sdk` and wraps command sync,
gateway identify/heartbeat/resume, interaction routing, replies, defers, edits,
and followups.

For local development against the default server port:

```ts
import { BotClient, InteractionResponseBuilder, SlashCommandBuilder } from '@paracord/bot-sdk';

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

## Example: send a message

```bash
curl -X POST "http://localhost:8090/api/v1/channels/<CHANNEL_ID>/messages" \
  -H "Authorization: Bot <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello from my Paracord bot"}'
```

## Security notes

- Keep tokens in secure server-side storage only.
- Regenerate tokens immediately if leaked.
- Use minimal permissions when generating install links.
- `redirect_uri` is strictly validated (`https` required except localhost dev URLs).
