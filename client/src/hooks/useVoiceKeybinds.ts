import { useEffect, useMemo, useRef } from 'react';
import { gateway } from '../gateway/manager';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';

type ParsedBinding = {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
};

function normalizeKey(input: string): string {
  const key = input.trim().toLowerCase();
  if (key === ' ') return 'space';
  if (key === 'esc') return 'escape';
  if (key === 'spacebar') return 'space';
  return key;
}

function parseBinding(raw: string): ParsedBinding | null {
  if (!raw || raw === 'Not set') return null;
  const parts = raw
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeKey);
  if (parts.length === 0) return null;

  const parsed: ParsedBinding = {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    key: '',
  };

  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') {
      parsed.ctrl = true;
      continue;
    }
    if (part === 'shift') {
      parsed.shift = true;
      continue;
    }
    if (part === 'alt' || part === 'option') {
      parsed.alt = true;
      continue;
    }
    if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'win') {
      parsed.meta = true;
      continue;
    }
    parsed.key = part;
  }

  return parsed.key ? parsed : null;
}

function matchesBinding(event: KeyboardEvent, binding: ParsedBinding | null): boolean {
  if (!binding) return false;

  if (event.ctrlKey !== binding.ctrl) return false;
  if (event.shiftKey !== binding.shift) return false;
  if (event.altKey !== binding.alt) return false;
  if (event.metaKey !== binding.meta) return false;

  return normalizeKey(event.key) === binding.key;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function publishVoiceState() {
  const state = useVoiceStore.getState();
  gateway.updateVoiceStateAll(
    state.guildId,
    state.channelId,
    state.selfMute,
    state.selfDeaf
  );
}

async function toggleMuteAndPublish() {
  await useVoiceStore.getState().toggleMute();
  publishVoiceState();
}

async function toggleDeafAndPublish() {
  await useVoiceStore.getState().toggleDeaf();
  publishVoiceState();
}

export function useVoiceKeybinds() {
  const rawKeybinds = useAuthStore((s) => s.settings?.keybinds as Record<string, unknown> | undefined);
  const pushToTalkEngaged = useRef(false);

  const bindings = useMemo(() => {
    const keybinds = rawKeybinds || {};
    return {
      toggleMute: parseBinding(String(keybinds.toggleMute || 'Ctrl+Shift+M')),
      toggleDeafen: parseBinding(String(keybinds.toggleDeafen || 'Ctrl+Shift+D')),
      pushToTalk: parseBinding(String(keybinds.pushToTalk || 'Not set')),
    };
  }, [rawKeybinds]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const voiceState = useVoiceStore.getState();
      if (!voiceState.connected || !voiceState.channelId) return;

      if (matchesBinding(event, bindings.toggleMute)) {
        if (event.repeat) return;
        event.preventDefault();
        void toggleMuteAndPublish();
        return;
      }

      if (matchesBinding(event, bindings.toggleDeafen)) {
        if (event.repeat) return;
        event.preventDefault();
        void toggleDeafAndPublish();
        return;
      }

      if (matchesBinding(event, bindings.pushToTalk)) {
        event.preventDefault();
        if (event.repeat || pushToTalkEngaged.current) return;
        if (voiceState.selfMute) {
          pushToTalkEngaged.current = true;
          void toggleMuteAndPublish();
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!matchesBinding(event, bindings.pushToTalk)) return;
      event.preventDefault();
      if (!pushToTalkEngaged.current) return;
      const voiceState = useVoiceStore.getState();
      if (!voiceState.connected || !voiceState.channelId) {
        pushToTalkEngaged.current = false;
        return;
      }
      if (!voiceState.selfMute) {
        void toggleMuteAndPublish();
      }
      pushToTalkEngaged.current = false;
    };

    const handleWindowBlur = () => {
      if (!pushToTalkEngaged.current) return;
      const voiceState = useVoiceStore.getState();
      if (voiceState.connected && voiceState.channelId && !voiceState.selfMute) {
        void toggleMuteAndPublish();
      }
      pushToTalkEngaged.current = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [bindings]);
}


