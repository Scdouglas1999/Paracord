import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useGlassStore } from '../../../stores/glassStore';
import { cn } from '../../../lib/utils';
import { SheetFrame, closeSheets } from '../../glass/sheets';
import { IxGlyph } from '../glyphs';
import { CreamButton } from '../primitives';
import { closeAddServer, useAddServerStore, type AddServerTab } from './addServerStore';
import { defaultServerName, useAddServerActions, useGuildTemplates, useServerIcon, type GuildTemplate } from './useAddServer';

/**
 * The Add a server sheet (docs/index-spec.md §4.8, §6.1, §8.3): what the dock's
 * `+` opens, inside main on its right like every other sheet, and what replaces
 * the Create / Join / Template dialog, the templates gallery and the discovery
 * entry.
 *
 *   Create     a name, a picture (optional) and what to start from: a blank server
 *              or one of the instance's templates.
 *   Join       an invite link or its code.
 *   Discover   opens the Discover page in main with the public servers.
 *
 * Discover is always offered: the page is served by every instance and says so
 * itself when it has nothing to show, so there is no flag to hide the entry
 * behind. Creating and joining land on the new server's landing channel and put
 * the sheet away; a failure stays in the sheet, in words, with the form intact.
 */

const TABS: { value: AddServerTab; label: string }[] = [
  { value: 'create', label: 'Create' },
  { value: 'join', label: 'Join' },
  { value: 'discover', label: 'Discover' },
];

export function AddServerSheet() {
  const open = useAddServerStore((state) => state.open);
  const tab = useAddServerStore((state) => state.tab);
  const setTab = useAddServerStore((state) => state.setTab);
  const { pathname } = useLocation();

  // One sheet at a time (§6.1): opening this one puts another away, and another
  // one opening puts this away.
  useEffect(() => {
    if (open) closeSheets();
  }, [open]);
  useEffect(
    () =>
      useGlassStore.subscribe((state, previous) => {
        if (state.sheet !== null && state.sheet !== previous.sheet) closeAddServer();
      }),
    [],
  );

  // Going to another place or conversation (the dock, a shortcut) puts it away,
  // as every sheet leaves when the page under it changes.
  const openedAt = useRef(pathname);
  useEffect(() => {
    if (open) openedAt.current = pathname;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && openedAt.current !== pathname) closeAddServer();
  }, [pathname, open]);

  return (
    <SheetFrame
      open={open}
      onClose={closeAddServer}
      label="Add a server"
      kind="add-server"
      title="Add a server"
    >
      <AddServerBody tab={tab} onTab={setTab} />
    </SheetFrame>
  );
}

function AddServerBody({ tab, onTab }: { tab: AddServerTab; onTab: (tab: AddServerTab) => void }) {
  const navigate = useNavigate();
  const ids = useId();
  const tabRefs = useRef(new Map<AddServerTab, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = TABS.findIndex((entry) => entry.value === tab);
    const next =
      event.key === 'ArrowRight' ? (at + 1) % TABS.length
      : event.key === 'ArrowLeft' ? (at - 1 + TABS.length) % TABS.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? TABS.length - 1
      : null;
    if (next === null) return;
    event.preventDefault();
    onTab(TABS[next].value);
    tabRefs.current.get(TABS[next].value)?.focus();
  };

  const done = useCallback(
    (path: string) => {
      closeAddServer();
      navigate(path);
    },
    [navigate],
  );

  return (
    <div className="ix-add">
      <div className="ix-add__tabs" role="tablist" aria-label="How to add a server">
        {TABS.map((entry) => (
          <button
            key={entry.value}
            ref={(element) => {
              if (element) tabRefs.current.set(entry.value, element);
              else tabRefs.current.delete(entry.value);
            }}
            type="button"
            role="tab"
            id={`${ids}-${entry.value}-tab`}
            aria-selected={tab === entry.value}
            aria-controls={`${ids}-panel`}
            tabIndex={tab === entry.value ? 0 : -1}
            className="ix-add__tab"
            onClick={() => onTab(entry.value)}
            onKeyDown={onKeyDown}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="ix-add__panel" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${tab}-tab`}>
        {tab === 'create' && <CreatePanel onDone={done} />}
        {tab === 'join' && <JoinPanel onDone={done} />}
        {tab === 'discover' && (
          <DiscoverPanel
            onOpen={() => {
              closeAddServer();
              navigate('/app/discovery');
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ---- Create ------------------------------------------------------------------------ */

function templateFacts(template: GuildTemplate): string {
  const channels = template.template_data.channels.filter((channel) => channel.type !== 4).length;
  const roles = template.template_data.roles.length;
  const parts = [channels === 1 ? '1 channel' : `${channels} channels`];
  if (roles > 0) parts.push(roles === 1 ? '1 role' : `${roles} roles`);
  return parts.join(' · ');
}

function CreatePanel({ onDone }: { onDone: (path: string) => void }) {
  const ids = useId();
  const user = useCurrentUser();
  const [name, setName] = useState(() => defaultServerName(user?.username));
  const [choice, setChoice] = useState<string | null>(null);
  const icon = useServerIcon();
  const templates = useGuildTemplates(true);
  const actions = useAddServerActions(onDone);

  const blank = choice === null || !templates.templates.some((template) => template.id === choice);
  const error = actions.error ?? icon.error;
  const ready = name.trim().length > 0 && !actions.loading;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    void (blank ? actions.create(name, icon.dataUrl) : actions.fromTemplate(choice as string, name));
  };

  return (
    <form className="ix-add__form" onSubmit={submit} noValidate>
      <div className="ix-add__field">
        <label className="ix-add__label" htmlFor={`${ids}-name`}>
          Server name
        </label>
        <input
          id={`${ids}-name`}
          className="ix-add__input"
          type="text"
          value={name}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          data-sheet-autofocus=""
          onChange={(event) => {
            setName(event.target.value);
            actions.clearError();
          }}
        />
      </div>

      <div className="ix-add__field" role="radiogroup" aria-labelledby={`${ids}-start`}>
        <span className="ix-add__label" id={`${ids}-start`}>
          Start from
        </span>
        <div className="ix-add__options">
          <TemplateOption
            selected={blank}
            title="Blank"
            line="A text channel and a voice channel. Add the rest as you go."
            onSelect={() => setChoice(null)}
          />
          {templates.templates.map((template) => (
            <TemplateOption
              key={template.id}
              selected={!blank && choice === template.id}
              title={template.name}
              line={template.description || templateFacts(template)}
              facts={template.description ? templateFacts(template) : null}
              onSelect={() => setChoice(template.id)}
            />
          ))}
        </div>
        {templates.loading && (
          <p className="ix-add__note" aria-live="polite">
            Loading templates…
          </p>
        )}
        {templates.error && (
          <p className="ix-add__note ix-add__note--error" role="alert">
            {templates.error}{' '}
            <button type="button" className="ix-add__link" onClick={templates.reload}>
              Try again
            </button>
          </p>
        )}
        {!templates.loading && !templates.error && templates.templates.length === 0 && (
          <p className="ix-add__note">Templates you save from a server&rsquo;s settings show up here.</p>
        )}
      </div>

      {blank && <PictureField icon={icon} />}

      {error && (
        <p className="ix-add__error" role="alert">
          {error}
        </p>
      )}

      <CreamButton type="submit" grow disabled={!ready} aria-busy={actions.loading || undefined}>
        {actions.loading ? 'Creating…' : 'Create server'}
      </CreamButton>
    </form>
  );
}

function TemplateOption({
  selected,
  title,
  line,
  facts,
  onSelect,
}: {
  selected: boolean;
  title: string;
  line: string;
  facts?: string | null;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className="ix-add__option"
      data-selected={selected ? '' : undefined}
      onClick={onSelect}
    >
      <span className="ix-add__radio" aria-hidden="true" />
      <span className="ix-add__option-text">
        <span className="ix-add__option-title">{title}</span>
        <span className="ix-add__option-line">{line}</span>
        {facts && <span className="ix-add__option-facts">{facts}</span>}
      </span>
    </button>
  );
}

function PictureField({ icon }: { icon: ReturnType<typeof useServerIcon> }) {
  const ids = useId();
  return (
    <div className="ix-add__field">
      <span className="ix-add__label" id={`${ids}-label`}>
        Picture
      </span>
      <div className="ix-add__picture">
        <label className="ix-add__pick">
          <input
            type="file"
            accept="image/*"
            className="ix-add__file"
            aria-labelledby={`${ids}-label`}
            onChange={(event) => icon.choose(event.target.files?.[0])}
          />
          <span className={cn('ix-add__tile', icon.preview && 'ix-add__tile--set')} aria-hidden="true">
            {icon.preview ? <img src={icon.preview} alt="" draggable={false} /> : <IxGlyph name="plus" size={16} />}
          </span>
          <span className="ix-add__pick-text">
            <span className="ix-add__pick-title">{icon.preview ? 'Change picture' : 'Add a picture'}</span>
            <span className="ix-add__pick-line">Optional. PNG, JPG, GIF or WEBP.</span>
          </span>
        </label>
        {icon.preview && (
          <button type="button" className="ix-add__link" onClick={icon.clear}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/* ---- Join -------------------------------------------------------------------------- */

function JoinPanel({ onDone }: { onDone: (path: string) => void }) {
  const ids = useId();
  const [invite, setInvite] = useState('');
  const actions = useAddServerActions(onDone);
  const ready = invite.trim().length > 0 && !actions.loading;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) void actions.join(invite);
  };

  return (
    <form className="ix-add__form" onSubmit={submit} noValidate>
      <div className="ix-add__field">
        <label className="ix-add__label" htmlFor={`${ids}-invite`}>
          Invite link
        </label>
        <input
          id={`${ids}-invite`}
          className="ix-add__input"
          type="text"
          value={invite}
          placeholder="https://chat.example.com/invite/hTKzmak"
          autoComplete="off"
          spellCheck={false}
          data-sheet-autofocus=""
          onChange={(event) => {
            setInvite(event.target.value);
            actions.clearError();
          }}
        />
        <p className="ix-add__note">Paste the whole link, or just the code at the end of it (hTKzmak).</p>
      </div>
      {actions.error && (
        <p className="ix-add__error" role="alert">
          {actions.error}
        </p>
      )}
      <CreamButton type="submit" grow disabled={!ready} aria-busy={actions.loading || undefined}>
        {actions.loading ? 'Joining…' : 'Join server'}
      </CreamButton>
    </form>
  );
}

/* ---- Discover ---------------------------------------------------------------------- */

function DiscoverPanel({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="ix-add__form">
      <div className="ix-add__discover">
        <span className="ix-add__discover-mark ix-hue-tile" aria-hidden="true">
          <IxGlyph name="people" size={18} />
        </span>
        <div className="ix-add__discover-text">
          <p className="ix-add__discover-title">Find a server to join</p>
          <p className="ix-add__discover-line">
            Browse the public servers on this instance, search them, and join one with a click.
          </p>
        </div>
      </div>
      <CreamButton type="button" grow onClick={onOpen} data-sheet-autofocus="">
        Discover servers
      </CreamButton>
    </div>
  );
}
