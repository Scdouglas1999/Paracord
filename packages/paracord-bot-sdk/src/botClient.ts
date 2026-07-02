import { ParacordGatewayClient } from './gateway.js';
import { ParacordRestClient } from './rest.js';
import type {
  BotClientOptions,
  InteractionPayload,
  InteractionResponse,
  SlashCommand,
} from './types.js';

type CommandHandler = (ctx: InteractionContext) => Promise<void> | void;

export interface InteractionContext {
  interaction: InteractionPayload;
  options: Map<string, unknown>;
  reply: (response: InteractionResponse) => Promise<void>;
  defer: (ephemeral?: boolean) => Promise<void>;
  editReply: (content: string) => Promise<void>;
  followUp: (content: string) => Promise<void>;
}

export class BotClient {
  readonly rest: ParacordRestClient;
  readonly gateway: ParacordGatewayClient;

  private readonly applicationId: string;
  private readonly registeredCommands: SlashCommand[] = [];
  private readonly commandHandlers = new Map<string, CommandHandler>();

  constructor(options: BotClientOptions) {
    this.applicationId = options.applicationId;
    this.rest = new ParacordRestClient({
      baseUrl: options.restBaseUrl,
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
    this.gateway = new ParacordGatewayClient({
      url: options.gatewayUrl,
      token: options.token,
      intents: options.intents ?? 0,
      wsFactory: options.wsFactory,
    });
    this.gateway.on<{ event: string; data: unknown }>('DISPATCH', ({ event, data }) => {
      if (event !== 'INTERACTION_CREATE') return;
      void this.handleInteraction(data as InteractionPayload);
    });
  }

  command(command: SlashCommand, handler: CommandHandler): this {
    this.registeredCommands.push(command);
    this.commandHandlers.set(command.name, handler);
    return this;
  }

  async start(options?: { syncCommands?: boolean; guildId?: string }): Promise<void> {
    if (options?.syncCommands) {
      if (options.guildId) {
        await this.rest.bulkOverwriteGuildCommands(
          this.applicationId,
          options.guildId,
          this.registeredCommands,
        );
      } else {
        await this.rest.bulkOverwriteGlobalCommands(this.applicationId, this.registeredCommands);
      }
    }
    await this.gateway.connect();
  }

  stop(): void {
    this.gateway.close(1000, 'Client stopped');
  }

  private async handleInteraction(interaction: InteractionPayload): Promise<void> {
    if (interaction.type !== 2) return;
    const commandName = interaction.data?.name;
    if (!commandName) return;
    const handler = this.commandHandlers.get(commandName);
    if (!handler) return;

    const options = new Map<string, unknown>();
    for (const option of interaction.data?.options ?? []) {
      options.set(option.name, option.value ?? null);
    }

    const ctx: InteractionContext = {
      interaction,
      options,
      reply: (response) =>
        this.rest.respondToInteraction(interaction.id, interaction.token, response),
      defer: (ephemeral = false) =>
        this.rest.respondToInteraction(interaction.id, interaction.token, {
          type: 5,
          data: ephemeral ? { flags: 1 << 6 } : undefined,
        }),
      editReply: (content) =>
        this.rest.editOriginalInteractionResponse(this.applicationId, interaction.token, { content }),
      followUp: (content) =>
        this.rest.createFollowupMessage(this.applicationId, interaction.token, { content }),
    };

    await handler(ctx);
  }
}
