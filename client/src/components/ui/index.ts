/**
 * The Lantern Stage primitive set (docs/lantern-stage-spec.md §1–§4, §9).
 *
 * These are the shared, prop-driven shells every package builds on: surfaces,
 * controls, rows and floating chrome, styled only from `src/styles/tokens.css`
 * and the `pc-*` recipes in `src/styles/primitives.css`. They carry no business
 * logic and no product copy.
 *
 * The light-specific components (WindowMap, LitAvatar, HereNowStrip,
 * RoomThumbnail, StageTile) are WP1 and compose these.
 *
 * `/design-tokens` (dev builds only) renders every token, type step, primitive
 * variant and state, in all four themes — start there.
 */
export { Plate, Lamp, type PlateProps, type LampProps } from './Plate';
export { Well, Raised, type WellProps, type RaisedProps } from './Well';
export { Button, buttonVariants, type ButtonProps } from './Button';
export { IconButton, type IconButtonProps, type IconButtonSize, type IconButtonTone } from './IconButton';
export { Chip, type ChipProps, type ChipTone } from './Chip';
export { NavRow, type NavRowProps } from './NavRow';
export { SectionLabel, type SectionLabelProps } from './SectionLabel';
export { Kbd, type KbdProps } from './Kbd';
export { TextField, SearchWell, type TextFieldProps, type SearchWellProps } from './TextField';
export { Divider, type DividerProps } from './Divider';
export { Popover, MenuItem, MenuLabel, type PopoverProps, type MenuItemProps } from './Popover';
export { Tooltip } from './Tooltip';
export { Switch, ToggleRow, type SwitchProps, type ToggleRowProps } from './Switch';
export { Tabs, type TabsProps, type TabItem } from './Tabs';
export {
  SettingsShell,
  SettingsSectionHeader,
  type SettingsShellProps,
  type SettingsNavItem,
  type SettingsNavGroup,
  type SettingsSectionHeaderProps,
} from './SettingsShell';
export { Input, Textarea, Select, type InputProps, type TextareaProps, type SelectProps } from './Input';
export { ErrorBanner, EmptyState, LoadingSpinner } from './Feedback';
export {
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  type ModalProps,
} from './Modal';
