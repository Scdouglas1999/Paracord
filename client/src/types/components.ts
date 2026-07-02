export enum ComponentType {
  ActionRow = 1,
  Button = 2,
  StringSelect = 3,
  TextInput = 4,
  UserSelect = 5,
  RoleSelect = 6,
  MentionableSelect = 7,
  ChannelSelect = 8,
}

export enum ButtonStyle {
  Primary = 1,
  Secondary = 2,
  Success = 3,
  Danger = 4,
  Link = 5,
}

export enum TextInputStyle {
  Short = 1,
  Paragraph = 2,
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export interface ComponentEmoji {
  id?: string;
  name?: string;
  animated?: boolean;
}

export interface Component {
  type: ComponentType;
  components?: Component[];
  custom_id?: string;
  style?: number;
  label?: string;
  emoji?: ComponentEmoji;
  url?: string;
  disabled?: boolean;
  options?: SelectOption[];
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  min_length?: number;
  max_length?: number;
  required?: boolean;
  value?: string;
}
