import {
  BotClient,
  InteractionResponseBuilder,
  SlashCommandBuilder,
} from '../src/index';

const token = process.env.PARACORD_BOT_TOKEN;
const appId = process.env.PARACORD_APP_ID;

if (!token || !appId) {
  throw new Error('Set PARACORD_BOT_TOKEN and PARACORD_APP_ID to run this example');
}

const bot = new BotClient({
  token,
  applicationId: appId,
  restBaseUrl: process.env.PARACORD_REST_BASE_URL ?? 'http://localhost:8080/api/v1',
  gatewayUrl: process.env.PARACORD_GATEWAY_URL ?? 'ws://localhost:8080/gateway',
});

bot.command(
  new SlashCommandBuilder().setName('ping').setDescription('Ping the bot').build(),
  async (ctx) => {
    await ctx.reply(InteractionResponseBuilder.message('Pong!'));
  },
);

await bot.start({ syncCommands: true });
