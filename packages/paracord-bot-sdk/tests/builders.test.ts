import { describe, expect, it } from 'vitest';
import {
  EmbedBuilder,
  InteractionResponseBuilder,
  SlashCommandBuilder,
} from '../src/index';

describe('builders', () => {
  it('builds slash commands with options', () => {
    const command = new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check bot health')
      .addStringOption('target', 'Optional target', false)
      .build();

    expect(command.name).toBe('ping');
    expect(command.description).toBe('Check bot health');
    expect(command.options).toHaveLength(1);
    expect(command.options?.[0].type).toBe(3);
  });

  it('builds embeds', () => {
    const embed = new EmbedBuilder()
      .setTitle('Title')
      .setDescription('Description')
      .setColor(0x57f287)
      .setFooter('Footer')
      .build();

    expect(embed.title).toBe('Title');
    expect(embed.description).toBe('Description');
    expect(embed.color).toBe(0x57f287);
    expect(embed.footer).toEqual({ text: 'Footer' });
  });

  it('builds interaction responses', () => {
    const normal = InteractionResponseBuilder.message('hello');
    const ephemeral = InteractionResponseBuilder.message('secret', true);
    const deferred = InteractionResponseBuilder.deferred(true);

    expect(normal.type).toBe(4);
    expect(normal.data?.flags).toBeUndefined();
    expect(ephemeral.data?.flags).toBe(64);
    expect(deferred.type).toBe(5);
    expect(deferred.data?.flags).toBe(64);
  });
});
