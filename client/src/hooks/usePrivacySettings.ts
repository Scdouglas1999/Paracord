import { useCallback, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { extractApiError } from '../api/client';
import { ACTIVITY_DETECTION_KEY, isActivityDetectionOn } from '../lib/features/privacyDefaults';

export type PrivacyKey = 'linkPreviews' | 'activity';

/**
 * The two privacy switches that live in the account's settings: link previews
 * (`user_settings.link_previews`) and "Show what I'm playing"
 * (`notifications.activityDetectionEnabled`). Shared by Settings › Privacy and
 * the "What's protected" sheet so both behave the same: a switch applies
 * immediately, and on failure it reverts and says why, inline (setup spec §1.10).
 */
export function usePrivacySettings() {
  const settings = useAuthStore((s) => s.settings);
  const updateSettings = useAuthStore((s) => s.updateSettings);
  const [pending, setPending] = useState<Partial<Record<PrivacyKey, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<PrivacyKey, string>>>({});

  const stored = {
    linkPreviews: settings?.link_previews ?? true,
    activity: isActivityDetectionOn(settings?.notifications),
  };

  const apply = useCallback(
    async (key: PrivacyKey, next: boolean) => {
      const current = useAuthStore.getState().settings;
      setErrors((prev) => ({ ...prev, [key]: undefined }));
      setPending((prev) => ({ ...prev, [key]: next }));
      try {
        if (key === 'linkPreviews') {
          await updateSettings({ link_previews: next });
        } else {
          await updateSettings({
            notifications: { ...(current?.notifications ?? {}), [ACTIVITY_DETECTION_KEY]: next },
          });
        }
      } catch (err) {
        setErrors((prev) => ({ ...prev, [key]: `Couldn't save that. ${extractApiError(err)}` }));
      } finally {
        setPending((prev) => ({ ...prev, [key]: undefined }));
      }
    },
    [updateSettings],
  );

  return {
    loaded: settings !== null,
    linkPreviews: pending.linkPreviews ?? stored.linkPreviews,
    /** Servers older than this release do not know the setting. */
    linkPreviewsSupported: settings?.link_previews !== undefined,
    /** The server turned fetching off for everyone. */
    linkPreviewsServerOff: settings?.link_previews_available === false,
    activity: pending.activity ?? stored.activity,
    busy: pending,
    errors,
    setLinkPreviews: (next: boolean) => apply('linkPreviews', next),
    setActivity: (next: boolean) => apply('activity', next),
  };
}
