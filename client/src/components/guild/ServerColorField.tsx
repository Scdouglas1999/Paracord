import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import { extractApiError } from '../../api/client';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { serverHue } from '../../lib/identityHue';
import { toast } from '../../stores/toastStore';
import { useGuildStore } from '../../stores/guildStore';
import type { Guild } from '../../types';
import { IxGlyph } from '../ix/glyphs';
import { ToolChip } from '../ix/primitives';
import { GroupLabel } from './SettingsPrimitives';
import { SERVER_COLOR_SWATCHES, readIconHue, swatchName } from './serverColor';

export interface ServerColorFieldProps {
  guild: Guild;
  /**
   * The icon as the admin sees it (a data URL: the saved icon, or the one just
   * picked). "Match icon" reads its color; with none the control is off.
   */
  iconSrc: string | null;
}

/**
 * Server settings › Overview › Server color (docs/index-spec.md §2.2, §8.3).
 *
 * The color that tints the window while you are in the server: one of the eleven
 * palette hues, or "Match icon", which computes the icon's dominant hue here, once,
 * and saves the number. A server with nothing picked is Automatic (its id decides),
 * and "Automatic" clears the pick. A choice saves on its own, like the banner
 * (`PATCH /guilds/{id}` with `hue`, Manage Server); the window follows when the
 * server echoes it back (`GUILD_UPDATE`), and the store takes the reply at once.
 *
 * Swatches are toggle buttons in one group, with arrows, Home and End moving between
 * them, so the group is one Tab stop plus the two chips after it. The pressed state
 * is a check and a ring as well as a color.
 */
export function ServerColorField({ guild, iconSrc }: ServerColorFieldProps) {
  const scope = useCurrentAccountScope();
  // The settings overlay holds its own copy of the guild, so the field keeps the
  // value it last saved (the store takes the reply too, which is what the window's
  // tint follows) and follows the copy when the overlay reads the guild again.
  const copyHue = guild.hue ?? null;
  const [saved, setSaved] = useState<{ guild: string; copy: number | null; value: number | null }>({
    guild: guild.id,
    copy: copyHue,
    value: copyHue,
  });
  const stored = saved.guild === guild.id && saved.copy === copyHue ? saved.value : copyHue;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'status' | 'error'; text: string } | null>(null);
  const swatches = useRef<(HTMLButtonElement | null)[]>([]);

  const onPalette = SERVER_COLOR_SWATCHES.some((swatch) => swatch.hue === stored);
  const custom = stored !== null && !onPalette;
  const automatic = stored === null;
  const effective = serverHue({ id: guild.id, hue: stored });

  const save = useCallback(
    async (hue: number | null, said: string) => {
      if (!scope) return;
      setBusy(true);
      setNote(null);
      try {
        await useGuildStore.getState().updateGuild(guild.id, { hue }, scope);
        setSaved({ guild: guild.id, copy: copyHue, value: hue });
        setNote({ kind: 'status', text: said });
      } catch (error) {
        // The store already toasted the refusal; say it next to the control too.
        setNote({ kind: 'error', text: `The server color was not saved: ${extractApiError(error)}` });
      } finally {
        setBusy(false);
      }
    },
    [guild.id, copyHue, scope],
  );

  const matchIcon = useCallback(async () => {
    if (!iconSrc) return;
    setBusy(true);
    setNote(null);
    const result = await readIconHue(iconSrc);
    setBusy(false);
    if (!result.ok) {
      const text =
        result.reason === 'colorless'
          ? 'This icon has no color to match. Pick a swatch instead.'
          : 'The icon could not be read. Pick a swatch instead.';
      setNote({ kind: 'error', text });
      toast.error(text);
      return;
    }
    await save(result.hue, 'Server color matched to the icon.');
  }, [iconSrc, save]);

  const focusSwatch = (index: number) => {
    const count = SERVER_COLOR_SWATCHES.length;
    swatches.current[(index + count) % count]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? SERVER_COLOR_SWATCHES.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    focusSwatch(to);
  };
  // One Tab stop: the pressed swatch, or the first.
  const tabStop = Math.max(0, SERVER_COLOR_SWATCHES.findIndex((swatch) => swatch.hue === stored));

  return (
    <section className="ix-color" aria-labelledby={`server-color-${guild.id}`}>
      <GroupLabel>
        <span id={`server-color-${guild.id}`}>Server color</span>
      </GroupLabel>
      <p className="ix-color__help">
        Tints the window while you are in this server. Until you pick one, the server's id decides.
      </p>

      <div className="ix-color__row">
        <div role="group" aria-label="Server color swatches" className="ix-color__swatches">
          {SERVER_COLOR_SWATCHES.map((swatch, index) => {
            const pressed = swatch.hue === stored;
            return (
              <button
                key={swatch.hue}
                ref={(node) => {
                  swatches.current[index] = node;
                }}
                type="button"
                className="ix-swatch"
                style={{ '--ix-h': swatch.hue } as CSSProperties}
                aria-label={swatch.name}
                aria-pressed={pressed}
                tabIndex={index === tabStop ? 0 : -1}
                disabled={busy}
                onKeyDown={(event) => onKeyDown(event, index)}
                onClick={() => void save(swatch.hue, `Server color set to ${swatch.name}.`)}
              >
                {pressed && <IxGlyph name="check" size={14} />}
              </button>
            );
          })}
          {custom && (
            <span
              className="ix-swatch ix-swatch--custom"
              style={{ '--ix-h': stored } as CSSProperties}
              role="img"
              aria-label="Matched to the icon, selected"
            >
              <IxGlyph name="check" size={14} />
            </span>
          )}
        </div>

        <div className="ix-color__chips">
          <ToolChip
            aria-pressed={automatic}
            disabled={busy}
            onClick={() => {
              if (!automatic) void save(null, 'Server color is automatic.');
            }}
          >
            Automatic
          </ToolChip>
          <ToolChip
            disabled={busy || !iconSrc}
            title={iconSrc ? undefined : 'Add a server icon to match it'}
            onClick={() => void matchIcon()}
          >
            Match icon
          </ToolChip>
        </div>
      </div>

      <p className="ix-color__now" data-testid="server-color-now">
        {automatic
          ? `Automatic. This server uses ${swatchName(effective) ?? 'its own color'}.`
          : swatchName(stored)
            ? `Using ${swatchName(stored)}.`
            : 'Matched to the icon.'}
      </p>
      {/* What just happened, for assistive tech: the line above already says it to everyone else. */}
      <p className="sr-only" role="status">
        {note?.kind === 'status' ? note.text : ''}
      </p>
      {note?.kind === 'error' && (
        <p className="ix-color__note" data-kind="error" role="alert">
          {note.text}
        </p>
      )}
    </section>
  );
}
