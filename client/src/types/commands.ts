export enum ApplicationCommandType {
  ChatInput = 1,
  User = 2,
  Message = 3,
}

export enum CommandOptionType {
  SubCommand = 1,
  SubCommandGroup = 2,
  String = 3,
  Integer = 4,
  Boolean = 5,
  User = 6,
  Channel = 7,
  Role = 8,
  Mentionable = 9,
  Number = 10,
  Attachment = 11,
}

export interface CommandOptionChoice {
  name: string;
  value: string | number;
}

export interface CommandOption {
  name: string;
  description: string;
  type: CommandOptionType;
  required?: boolean;
  choices?: CommandOptionChoice[];
  options?: CommandOption[];
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  autocomplete?: boolean;
}

export interface ApplicationCommand {
  id: string;
  application_id: string;
  guild_id?: string;
  name: string;
  description: string;
  options: CommandOption[];
  type: ApplicationCommandType;
  default_member_permissions?: string;
  dm_permission: boolean;
  nsfw: boolean;
  version: number;
}
