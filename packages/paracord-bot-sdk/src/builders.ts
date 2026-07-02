import type {
  InteractionCallbackData,
  InteractionResponse,
  SlashCommand,
  SlashCommandOption,
} from './types.js';

export class SlashCommandBuilder {
  private command: SlashCommand;

  constructor() {
    this.command = {
      name: '',
      description: '',
      options: [],
      type: 1,
      dm_permission: true,
      nsfw: false,
    };
  }

  setName(name: string): this {
    this.command.name = name.trim().toLowerCase();
    return this;
  }

  setDescription(description: string): this {
    this.command.description = description.trim();
    return this;
  }

  addStringOption(
    name: string,
    description: string,
    required = false,
  ): this {
    const option: SlashCommandOption = {
      type: 3,
      name,
      description,
      required,
    };
    this.command.options = [...(this.command.options ?? []), option];
    return this;
  }

  build(): SlashCommand {
    if (!this.command.name) {
      throw new Error('Command name is required');
    }
    if (!this.command.description) {
      throw new Error('Command description is required');
    }
    return { ...this.command, options: [...(this.command.options ?? [])] };
  }
}

export class EmbedBuilder {
  private data: Record<string, unknown> = {};

  setTitle(title: string): this {
    this.data.title = title;
    return this;
  }

  setDescription(description: string): this {
    this.data.description = description;
    return this;
  }

  setColor(color: number): this {
    this.data.color = color;
    return this;
  }

  setFooter(text: string): this {
    this.data.footer = { text };
    return this;
  }

  setTimestamp(timestamp = new Date().toISOString()): this {
    this.data.timestamp = timestamp;
    return this;
  }

  build(): Record<string, unknown> {
    return { ...this.data };
  }
}

export class InteractionResponseBuilder {
  static message(content: string, ephemeral = false): InteractionResponse {
    const data: InteractionCallbackData = {
      content,
      ...(ephemeral ? { flags: 1 << 6 } : {}),
    };
    return { type: 4, data };
  }

  static deferred(ephemeral = false): InteractionResponse {
    return {
      type: 5,
      data: ephemeral ? { flags: 1 << 6 } : undefined,
    };
  }

  static withEmbed(
    embed: Record<string, unknown>,
    content?: string,
    ephemeral = false,
  ): InteractionResponse {
    const data: InteractionCallbackData = {
      ...(content ? { content } : {}),
      embeds: [embed as Record<string, never>],
      ...(ephemeral ? { flags: 1 << 6 } : {}),
    };
    return { type: 4, data };
  }
}
