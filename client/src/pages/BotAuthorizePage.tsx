import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { cn } from '../lib/utils';
import {
  AtSign,
  Ban,
  Bot,
  ExternalLink,
  Hash,
  type LucideIcon,
  MessageSquare,
  Mic,
  ScrollText,
  Settings2,
  Shield,
  ShieldAlert,
  Smile,
  Star,
  Trash2,
  UserCog,
  UserX,
  Video,
  Webhook,
} from 'lucide-react';
import { botApi, type PublicBotApplication } from '../api/bots';
import { botStoreApi, type BotReview } from '../api/botStore';
import { extractApiError } from '../api/client';
import { guildApi } from '../api/guilds';
import { Permissions } from '../types/permissions.types';
import type { Guild } from '../types';
import { Button, buttonVariants } from '../components/ui/Button';
import { Avatar } from '../components/ix/identity';
import { PEOPLE_HUE } from '../lib/identityHue';
import { ErrorBanner } from '../components/ui/Feedback';
import { Divider } from '../components/ui/Divider';
import { Select, Textarea } from '../components/ui/Input';
import { AuthCard, AuthHeading, SuccessNote } from './authScaffold';

type ScopeRisk = 'high' | 'medium' | 'low';

interface ScopeDef {
  flag: bigint;
  label: string;
  description: string;
  risk: ScopeRisk;
  icon: LucideIcon;
}

/**
 * Human-readable scope catalog for the OAuth consent screen. Order within a
 * risk tier is meaningful (most consequential first); the UI groups these by
 * `risk` so a user sees dangerous grants before routine ones.
 */
const SCOPE_CATALOG: ScopeDef[] = [
  { flag: Permissions.ADMINISTRATOR, label: 'Administrator', description: 'Full, unrestricted control over this server — this grant includes every other permission.', risk: 'high', icon: ShieldAlert },
  { flag: Permissions.BAN_MEMBERS, label: 'Ban members', description: 'Permanently remove members and block them from rejoining.', risk: 'high', icon: Ban },
  { flag: Permissions.KICK_MEMBERS, label: 'Kick members', description: 'Remove members from the server.', risk: 'high', icon: UserX },
  { flag: Permissions.MANAGE_GUILD, label: 'Manage server', description: 'Change the server name, region, and core settings.', risk: 'high', icon: Settings2 },
  { flag: Permissions.MANAGE_ROLES, label: 'Manage roles', description: 'Create, edit, and assign roles and their permissions.', risk: 'high', icon: Shield },
  { flag: Permissions.MANAGE_CHANNELS, label: 'Manage channels', description: 'Create, edit, and delete channels.', risk: 'high', icon: Hash },
  { flag: Permissions.MANAGE_WEBHOOKS, label: 'Manage webhooks', description: 'Create and manage webhooks that post into channels.', risk: 'high', icon: Webhook },
  { flag: Permissions.MANAGE_MESSAGES, label: 'Manage messages', description: 'Delete or pin anyone’s messages.', risk: 'high', icon: Trash2 },

  { flag: Permissions.MANAGE_NICKNAMES, label: 'Manage nicknames', description: 'Change other members’ nicknames.', risk: 'medium', icon: UserCog },
  { flag: Permissions.MANAGE_EMOJIS, label: 'Manage emojis', description: 'Add and remove custom server emojis.', risk: 'medium', icon: Smile },
  { flag: Permissions.MUTE_MEMBERS, label: 'Mute members', description: 'Silence members in voice channels.', risk: 'medium', icon: Mic },
  { flag: Permissions.MOVE_MEMBERS, label: 'Move members', description: 'Drag members between voice channels.', risk: 'medium', icon: UserCog },
  { flag: Permissions.MENTION_EVERYONE, label: 'Mention @everyone', description: 'Ping every member with @everyone and @here.', risk: 'medium', icon: AtSign },
  { flag: Permissions.VIEW_AUDIT_LOG, label: 'View audit log', description: 'Read the record of administrative actions.', risk: 'medium', icon: ScrollText },

  { flag: Permissions.VIEW_CHANNEL, label: 'View channels', description: 'See channels and read their contents.', risk: 'low', icon: Hash },
  { flag: Permissions.SEND_MESSAGES, label: 'Send messages', description: 'Post messages in text channels.', risk: 'low', icon: MessageSquare },
  { flag: Permissions.READ_MESSAGE_HISTORY, label: 'Read message history', description: 'View messages sent before it joined.', risk: 'low', icon: MessageSquare },
  { flag: Permissions.ADD_REACTIONS, label: 'Add reactions', description: 'React to messages with emoji.', risk: 'low', icon: Smile },
  { flag: Permissions.CREATE_INSTANT_INVITE, label: 'Create invites', description: 'Generate invite links to this server.', risk: 'low', icon: AtSign },
  { flag: Permissions.CONNECT, label: 'Join voice', description: 'Connect to voice channels.', risk: 'low', icon: Mic },
  { flag: Permissions.SPEAK, label: 'Speak in voice', description: 'Transmit audio in voice channels.', risk: 'low', icon: Mic },
  { flag: Permissions.STREAM, label: 'Stream video', description: 'Share video and screen in voice channels.', risk: 'low', icon: Video },
];

// The kind is carried by the words and the order, not by hue: sensitive access
// takes the one danger ink, the rest are quiet fills (no amber: amber means live).
const RISK_META: Record<ScopeRisk, { label: string; iconWell: string }> = {
  high: { label: 'Sensitive access', iconWell: 'bg-[var(--ix-danger-fill)] text-[var(--ix-danger-ink)]' },
  medium: { label: 'Moderation', iconWell: 'bg-[var(--ix-fill-ctl)] text-[var(--ix-ink-2)]' },
  low: { label: 'Standard access', iconWell: 'bg-[var(--ix-fill)] text-[var(--ix-ink-3)]' },
};

function decodeScopes(permissions: string): ScopeDef[] {
  let bits: bigint;
  try {
    bits = BigInt(permissions || '0');
  } catch {
    bits = 0n;
  }
  return SCOPE_CATALOG.filter((scope) => (bits & scope.flag) === scope.flag);
}

/**
 * Validate and build the OAuth redirect URL.
 *
 * Security: blocks dangerous URI schemes (javascript:, data:, vbscript:, blob:)
 * and requires https:// for non-localhost origins.  If the bot's registered
 * redirect_uri is available, the requested URI must match it exactly (origin +
 * path), with only query parameters allowed to differ.
 */
function buildRedirectUrl(
  redirectUri: string,
  applicationId: string,
  guildId: string,
  state: string | null,
  registeredRedirectUri?: string | null,
): string | null {
  try {
    const url = new URL(redirectUri);

    // Block dangerous URI schemes
    const scheme = url.protocol.toLowerCase();
    if (
      scheme === 'javascript:' ||
      scheme === 'data:' ||
      scheme === 'vbscript:' ||
      scheme === 'blob:'
    ) {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }

    // Require https:// for non-localhost origins
    const hostname = url.hostname.toLowerCase();
    const isLocalhost =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    if (!isLocalhost && scheme !== 'https:') {
      return null;
    }

    // If the bot has a registered redirect URI, validate against it
    if (registeredRedirectUri) {
      try {
        const registered = new URL(registeredRedirectUri);
        if (registered.username || registered.password) {
          return null;
        }
        // Origin + pathname must match exactly
        if (
          url.origin.toLowerCase() !== registered.origin.toLowerCase() ||
          url.pathname !== registered.pathname
        ) {
          return null;
        }
      } catch {
        // Registered URI is malformed — reject the redirect
        return null;
      }
    }

    url.searchParams.set('authorized', 'true');
    url.searchParams.set('application_id', applicationId);
    url.searchParams.set('guild_id', guildId);
    if (state) {
      url.searchParams.set('state', state);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function botAuthorizeError(action: string, err: unknown): string {
  const detail = extractApiError(err);
  return detail ? `${action}: ${detail}` : action;
}

export function BotAuthorizePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const applicationId = params.get('client_id') || params.get('application_id') || '';
  // A bot-invite link names the space it wants: `?client_id=…&guild_id=…`. It is
  // the same shape this page emits on its own redirect, and it was read only
  // there — the picker ignored it and defaulted to whichever space happened to
  // come back first, so a one-click invite quietly aimed at the wrong space.
  const requestedGuildId = params.get('guild_id') || '';
  const requestedPermissions = params.get('permissions');
  const requestedRedirectUri = params.get('redirect_uri');
  const oauthState = params.get('state');

  const [application, setApplication] = useState<PublicBotApplication | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [authorizedGuildId, setAuthorizedGuildId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<BotReview[]>([]);
  const [reviewSummary, setReviewSummary] = useState<{ review_count: number; average_rating: number } | null>(null);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewBody, setReviewBody] = useState('');

  useEffect(() => {
    if (!applicationId) {
      setError('Missing bot application ID in invite link.');
      return;
    }

    let canceled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      botApi.getPublic(applicationId),
      guildApi.getAll(),
      botStoreApi.listReviews(applicationId).catch(() => null),
    ])
      .then(([appRes, guildsRes, reviewsRes]) => {
        if (canceled) return;
        setApplication(appRes.data);
        setGuilds(guildsRes.data);
        if (reviewsRes?.data) {
          setReviews(reviewsRes.data.reviews || []);
          setReviewSummary(reviewsRes.data.summary);
        }
        if (guildsRes.data.length > 0) {
          const requested = guildsRes.data.find((guild) => String(guild.id) === requestedGuildId);
          setSelectedGuildId(requested?.id ?? guildsRes.data[0].id);
        }
      })
      .catch((err: unknown) => {
        if (canceled) return;
        setError(botAuthorizeError('Failed to load authorization details', err));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [applicationId, requestedGuildId]);

  const effectivePermissions = requestedPermissions || application?.permissions || '0';
  const effectiveRedirectUri = requestedRedirectUri || application?.redirect_uri || null;
  const continueUrl = useMemo(() => {
    if (!authorizedGuildId || !effectiveRedirectUri || !applicationId) return null;
    return buildRedirectUrl(
      effectiveRedirectUri,
      applicationId,
      authorizedGuildId,
      oauthState,
      application?.redirect_uri,
    );
  }, [authorizedGuildId, effectiveRedirectUri, applicationId, oauthState, application?.redirect_uri]);

  const scopeGroups = useMemo(() => {
    const granted = decodeScopes(effectivePermissions);
    const order: ScopeRisk[] = ['high', 'medium', 'low'];
    return order
      .map((risk) => ({ risk, items: granted.filter((scope) => scope.risk === risk) }))
      .filter((group) => group.items.length > 0);
  }, [effectivePermissions]);

  const authorize = async () => {
    if (!applicationId || !selectedGuildId) return;
    setSubmitting(true);
    setError(null);
    try {
      await botApi.addBotToGuild(selectedGuildId, {
        application_id: applicationId,
        permissions: effectivePermissions,
        redirect_uri: requestedRedirectUri || undefined,
        state: oauthState || undefined,
      });
      setAuthorizedGuildId(selectedGuildId);
    } catch (err: unknown) {
      setError(botAuthorizeError('Authorization failed', err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitReview = async () => {
    if (!applicationId) return;
    try {
      const { data } = await botStoreApi.upsertMyReview(applicationId, {
        rating: reviewRating,
        body: reviewBody.trim() || undefined,
      });
      setReviewSummary(data.summary);
      const { data: reviewsData } = await botStoreApi.listReviews(applicationId);
      setReviews(reviewsData.reviews);
      setReviewBody('');
    } catch (err: unknown) {
      setError(botAuthorizeError('Failed to submit review', err));
    }
  };

  // This route lives inside the app shell (/app/oauth2/authorize), so it fills
  // the shell's outlet rather than claiming the viewport: the entry pages' ground
  // with the main glow at hue 210 and one 400px column on it (docs/index-spec.md
  // §6.14, §8.1 "bot authorize keeps the auth layout"), the consent first and the
  // reviews under it as a sibling card.
  return (
    <div
      className="ix-auth ix-hue-main ix-lt--main flex h-full min-h-0 flex-col"
      style={{ '--ix-hue': PEOPLE_HUE } as CSSProperties}
    >
      <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-6 sm:py-12">
        <div className="mx-auto flex w-full max-w-[400px] flex-col gap-8">
          <AuthCard>
            <div className="flex flex-col gap-5">
              <AuthHeading
                mark={false}
                title="Add a bot to your server"
                subtitle="Review what this application can do, then choose where to install it. You stay in control."
              />

              {error && <ErrorBanner multiline message={error} />}

              {loading ? (
                <div className="pc-well flex items-center gap-2.5 px-5 py-6 text-[14px] text-[var(--ix-ink-2)]">
                  <Bot size={18} className="shrink-0 text-[var(--ix-ink-2)]" aria-hidden />
                  Loading bot authorization details…
                </div>
              ) : (
                <>
                  {/* Requesting application identity */}
                  <div className="flex items-start gap-4">
                    {application?.bot_user ? (
                      <Avatar
                        userId={application.bot_user.id}
                        name={application.name}
                        avatar={application.bot_user.avatar_hash}
                        size={56}
                        ring="var(--ix-main)"
                      />
                    ) : (
                      <div
                        className="ix-hue-tile flex h-14 w-14 shrink-0 items-center justify-center rounded-[16px]"
                        aria-hidden
                      >
                        <Bot size={26} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <h2 className="ix-auth__step">
                        {application?.name || `Bot App ${applicationId}`}
                      </h2>
                      {reviewSummary && (
                        <p className="mt-1 inline-flex items-center gap-1.5 text-[12.5px] text-[var(--ix-ink-3)]">
                          <Star size={12} aria-hidden />
                          {reviewSummary.average_rating.toFixed(1)} average ({reviewSummary.review_count} reviews)
                        </p>
                      )}
                      {application?.description && (
                        <p className="mt-2 text-[14px] leading-[1.5] text-[var(--ix-ink-2)]">{application.description}</p>
                      )}
                      <p className="mt-2 pc-mono text-[12px] text-[var(--ix-ink-3)]">ID: {applicationId}</p>
                    </div>
                  </div>

                  <Divider />

                  {/* Install target */}
                  <div>
                    <label htmlFor="bot-authorize-server" className="text-[13px] font-medium text-[var(--ix-ink-2)]">
                      Install on
                    </label>
                    <Select
                      id="bot-authorize-server"
                      className="mt-2 w-full"
                      aria-label="Select server"
                      value={selectedGuildId}
                      onChange={(e) => setSelectedGuildId(e.target.value)}
                      disabled={guilds.length === 0 || submitting || Boolean(authorizedGuildId)}
                    >
                      {guilds.length === 0 && <option value="">No servers available</option>}
                      {guilds.map((guild) => (
                        <option key={guild.id} value={guild.id}>
                          {guild.name}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <Divider />

                  {/* Requested scopes, grouped by risk */}
                  <div>
                    <p className="text-[13px] font-medium text-[var(--ix-ink-2)]">This bot will be able to</p>
                    {scopeGroups.length === 0 ? (
                      <p className="mt-3 text-[14px] text-[var(--ix-ink-2)]">
                        No special permissions requested — it can only do what any member can.
                      </p>
                    ) : (
                      <div className="mt-3 max-h-72 space-y-5 overflow-y-auto pr-1">
                        {scopeGroups.map((group) => (
                          <div key={group.risk}>
                            <p className="text-[12.5px] font-semibold text-[var(--ix-ink-3)]">
                              {RISK_META[group.risk].label}
                            </p>
                            <ul className="mt-2 space-y-2">
                              {group.items.map((scope) => (
                                <li key={scope.label} className="flex items-start gap-3">
                                  <span
                                    aria-hidden
                                    className={cn(
                                      'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]',
                                      RISK_META[group.risk].iconWell,
                                    )}
                                  >
                                    <scope.icon size={16} />
                                  </span>
                                  <div className="min-w-0">
                                    <p className="text-[14px] font-semibold text-[var(--ix-ink)]">
                                      {scope.label}
                                    </p>
                                    <p className="text-[13px] leading-[1.4] text-[var(--ix-ink-3)]">
                                      {scope.description}
                                    </p>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="mt-4 pc-mono text-[12px] text-[var(--ix-ink-3)]">
                      Permission bits: {effectivePermissions}
                    </p>
                  </div>

                  <Divider />

                  {/* Trust / result + actions */}
                  <div>
                    {authorizedGuildId ? (
                      <SuccessNote>
                        Bot authorized successfully for server ID {authorizedGuildId}.
                      </SuccessNote>
                    ) : (
                      <div className="pc-well flex items-start gap-2.5 px-4 py-3 text-[13px] leading-[1.5] text-[var(--ix-ink-2)]">
                        <ShieldAlert size={15} className="mt-px shrink-0 text-[var(--ix-ink-2)]" aria-hidden />
                        <span>
                          Only continue if you trust this application. You can remove it from your
                          server’s settings at any time.
                        </span>
                      </div>
                    )}

                    {authorizedGuildId && effectiveRedirectUri && !continueUrl && (
                      <p className="mt-3 flex items-start gap-1.5 text-[13px] leading-[1.5] text-[var(--ix-danger-ink)]">
                        <ShieldAlert size={13} className="mt-px shrink-0" aria-hidden />
                        Redirect URL was blocked because it uses an unsafe scheme or does not match the bot's registered URI.
                      </p>
                    )}

                    <div className="mt-5 flex flex-wrap items-center justify-end gap-2.5">
                      {!authorizedGuildId && (
                        <>
                          <Button variant="ghost" onClick={() => navigate('/app')}>
                            Cancel
                          </Button>
                          <Button
                            className="min-w-[9rem]"
                            onClick={() => void authorize()}
                            loading={submitting}
                            disabled={!selectedGuildId || submitting}
                          >
                            Authorize
                          </Button>
                        </>
                      )}
                      {continueUrl && (
                        <a
                          href={continueUrl}
                          rel="noopener noreferrer"
                          className={buttonVariants({ variant: 'glass' })}
                        >
                          Continue to app
                          <ExternalLink size={14} aria-hidden />
                        </a>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </AuthCard>

          {/* Community reviews — a sibling card under the consent, never a card
              nested inside it.

              Only store-listed bots have reviews: for anything else the list
              request answers 404 and every review posted here would be refused
              the same way. `reviewSummary` is set only when that request
              answered, so it is the honest test for "the store knows this bot".
              Offering a rating box that cannot accept a rating is worse than
              offering nothing. */}
          {!loading && reviewSummary && (
            <section className="rounded-[20px] bg-[var(--ix-card)] p-5 shadow-[var(--ix-shadow-event)]">
              <p className="text-[13px] font-medium text-[var(--ix-ink-2)]">Rate this bot</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Select
                  className="w-auto"
                  aria-label="Review rating"
                  value={reviewRating}
                  onChange={(event) => setReviewRating(Number(event.target.value))}
                >
                  <option value={5}>5 - Excellent</option>
                  <option value={4}>4 - Good</option>
                  <option value={3}>3 - Okay</option>
                  <option value={2}>2 - Poor</option>
                  <option value={1}>1 - Bad</option>
                </Select>
                <Button type="button" variant="glass" onClick={() => void submitReview()}>
                  Submit review
                </Button>
              </div>
              <Textarea
                className="mt-3 min-h-20 resize-y"
                aria-label="Review body"
                placeholder="Share your experience (optional)"
                value={reviewBody}
                onChange={(event) => setReviewBody(event.target.value)}
                maxLength={2000}
              />
              {reviews.length > 0 && (
                <ul className="mt-4 max-h-40 space-y-2 overflow-y-auto">
                  {reviews.slice(0, 5).map((review) => (
                    <li key={review.id} className="rounded-[12px] bg-[var(--ix-fill)] px-3.5 py-2.5">
                      <div className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-[var(--ix-ink)]">
                        <Star size={11} aria-hidden />
                        {review.rating}/5
                      </div>
                      {review.body && (
                        <p className="mt-1 text-[13px] leading-[1.4] text-[var(--ix-ink-2)]">
                          {review.body}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
