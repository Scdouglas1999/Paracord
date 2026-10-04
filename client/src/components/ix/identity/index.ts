/**
 * Identity (docs/index-spec.md §2.3): the one way to draw a person, a server
 * and presence. Flat tonal fills, a lighter same-hue letter, a hairline; an
 * uploaded picture always wins. See styles/ix-base.css for the recipes and
 * lib/identityHue.ts for the hues.
 */
export { Avatar } from './Avatar';
export type { AvatarProps } from './Avatar';
export { AvatarStack } from './AvatarStack';
export type { AvatarStackPerson, AvatarStackProps } from './AvatarStack';
export { ServerMark } from './ServerMark';
export type { ServerMarkProps } from './ServerMark';
export { PresenceDot, presenceKind } from './PresenceDot';
export type { PresenceDotProps, PresenceKind } from './PresenceDot';
export { graphemes, monogramFontSize, monogramOf } from './monogram';
export type { MonogramShape } from './monogram';
