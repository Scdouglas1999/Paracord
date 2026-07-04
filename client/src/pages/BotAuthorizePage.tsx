import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cn } from '../lib/utils';
import {
  AtSign,
  Ban,
  Bot,
  Check,
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
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/Feedback';

type ScopeRisk = 'high' | 'medium' | 'low';

interface ScopeDef {
  flag: bigint;
  label: string;
  description: string;
  risk: ScopeRisk;
  icon: LucideIcon;
}

/**
 * Human-readable scope catalogue for the OAuth consent screen. Order within a
 * risk tier is meaningful (most consequential first); the UI groups these by
 * `risk` so a user sees dangerous grants before routine ones.
 */
const SCOPE_CATALOGUE: ScopeDef[] = [
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

const RISK_META: Record<ScopeRisk, { label: string; iconWell: string }> = {
  high: { label: 'Sensitive access', iconWell: 'bg-danger-tint text-accent-danger' },
  medium: { label: 'Moderation', iconWell: 'bg-warning-tint text-accent-warning' },
  low: { label: 'Standard access', iconWell: 'bg-accent-tint text-accent-primary' },
};

function decodeScopes(permissions: string): ScopeDef[] {
  let bits: bigint;
  try {
    bits = BigInt(permissions || '0');
  } catch {
    bits = 0n;
  }
  return SCOPE_CATALOGUE.filter((scope) => (bits & scope.flag) === scope.flag);
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

    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      botApi.getPublic(applicationId),
      guildApi.getAll(),
      botStoreApi.listReviews(applicationId).catch(() => null),
    ])
      .then(([appRes, guildsRes, reviewsRes]) => {
        if (cancelled) return;
        setApplication(appRes.data);
        setGuilds(guildsRes.data);
        if (reviewsRes?.data) {
          setReviews(reviewsRes.data.reviews || []);
          setReviewSummary(reviewsRes.data.summary);
        }
        if (guildsRes.data.length > 0) {
          setSelectedGuildId(guildsRes.data[0].id);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(botAuthorizeError('Failed to load authorization details', err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [applicationId]);

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
        <div className="mx-auto w-full max-w-2xl space-y-5">
          <div>
            <p className="text-section uppercase text-accent-primary">Authorize application</p>
            <h1 className="mt-1 font-display text-title text-text-primary">Add a bot to your server</h1>
            <p className="mt-1.5 text-body text-text-secondary">
              Review what this application can do, then choose where to install it. You stay in control.
            </p>
          </div>

          {error && <ErrorBanner message={error} />}

          {loading ? (
            <div className="flex items-center gap-2.5 rounded-md border border-border-subtle bg-bg-secondary px-5 py-6 text-body text-text-muted shadow-sm">
              <Bot size={18} className="shrink-0 text-accent-primary" />
              Loading bot authorization details…
            </div>
          ) : (
            <>
              <div className="rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
                {/* Requesting application identity */}
                <div className="flex items-start gap-4 p-6">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
                    <Bot size={26} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-subhead font-semibold text-text-primary">
                      {application?.name || `Bot App ${applicationId}`}
                    </h2>
                    {reviewSummary && (
                      <p className="mt-1 inline-flex items-center gap-1.5 text-meta text-text-muted">
                        <Star size={12} className="text-accent-warning" />
                        {reviewSummary.average_rating.toFixed(1)} average ({reviewSummary.review_count} reviews)
                      </p>
                    )}
                    {application?.description && (
                      <p className="mt-2 text-body text-text-secondary">{application.description}</p>
                    )}
                    <p className="mt-2 font-code text-meta text-text-muted">ID: {applicationId}</p>
                  </div>
                </div>

                {/* Install target */}
                <div className="border-t border-border-subtle p-6">
                  <label
                    htmlFor="bot-authorize-server"
                    className="text-section uppercase text-text-secondary"
                  >
                    Install on
                  </label>
                  <select
                    id="bot-authorize-server"
                    className="select-field mt-2 w-full"
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
                  </select>
                </div>

                {/* Requested scopes, grouped by risk */}
                <div className="border-t border-border-subtle p-6">
                  <p className="text-section uppercase text-text-secondary">This bot will be able to</p>
                  {scopeGroups.length === 0 ? (
                    <p className="mt-3 text-body text-text-secondary">
                      No special permissions requested — it can only do what any member can.
                    </p>
                  ) : (
                    <div className="mt-3 max-h-72 space-y-5 overflow-y-auto pr-1">
                      {scopeGroups.map((group) => (
                        <div key={group.risk}>
                          <p className="text-section uppercase text-text-muted">
                            {RISK_META[group.risk].label}
                          </p>
                          <ul className="mt-2 space-y-2">
                            {group.items.map((scope) => (
                              <li key={scope.label} className="flex items-start gap-3">
                                <span
                                  className={cn(
                                    'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                                    RISK_META[group.risk].iconWell,
                                  )}
                                >
                                  <scope.icon size={16} />
                                </span>
                                <div className="min-w-0">
                                  <p className="text-label font-semibold text-text-primary">{scope.label}</p>
                                  <p className="text-meta leading-relaxed text-text-secondary">
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
                  <p className="mt-4 font-code text-meta text-text-muted">
                    Permission bits: {effectivePermissions}
                  </p>
                </div>

                {/* Trust / result + actions */}
                <div className="border-t border-border-subtle p-6">
                  {authorizedGuildId ? (
                    <div className="flex items-start gap-2.5 rounded-md border border-accent-success/30 bg-success-tint px-4 py-3 text-label text-accent-success">
                      <Check size={16} className="mt-px shrink-0" />
                      <span>Bot authorized successfully for server ID {authorizedGuildId}.</span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2.5 rounded-md border border-border-subtle bg-bg-tertiary/50 px-4 py-3 text-meta leading-relaxed text-text-secondary">
                      <ShieldAlert size={15} className="mt-px shrink-0 text-accent-warning" />
                      <span>
                        Only continue if you trust this application. You can remove it from your server’s
                        settings at any time.
                      </span>
                    </div>
                  )}

                  {authorizedGuildId && effectiveRedirectUri && !continueUrl && (
                    <p className="mt-3 flex items-start gap-1.5 text-meta text-accent-danger">
                      <ShieldAlert size={13} className="mt-px shrink-0" />
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
                        className="inline-flex items-center gap-1.5 rounded-sm border border-border-subtle px-3.5 py-2 text-label font-semibold text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                      >
                        Continue to App
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                </div>
              </div>

              {/* Community reviews */}
              <div className="rounded-md border border-border-subtle bg-bg-secondary p-6 shadow-sm">
                <p className="text-section uppercase text-text-secondary">Rate this bot</p>
                <div className="mt-3 flex items-center gap-2">
                  <select
                    className="select-field"
                    aria-label="Review rating"
                    value={reviewRating}
                    onChange={(event) => setReviewRating(Number(event.target.value))}
                  >
                    <option value={5}>5 - Excellent</option>
                    <option value={4}>4 - Good</option>
                    <option value={3}>3 - Okay</option>
                    <option value={2}>2 - Poor</option>
                    <option value={1}>1 - Bad</option>
                  </select>
                  <Button type="button" onClick={() => void submitReview()}>
                    Submit Review
                  </Button>
                </div>
                <textarea
                  className="input-field mt-3 min-h-20 resize-y text-body"
                  aria-label="Review body"
                  placeholder="Share your experience (optional)"
                  value={reviewBody}
                  onChange={(event) => setReviewBody(event.target.value)}
                  maxLength={2000}
                />
                {reviews.length > 0 && (
                  <ul className="mt-4 max-h-40 space-y-2 overflow-y-auto">
                    {reviews.slice(0, 5).map((review) => (
                      <li
                        key={review.id}
                        className="rounded-md border border-border-subtle bg-bg-tertiary/40 px-3.5 py-2.5"
                      >
                        <div className="inline-flex items-center gap-1 text-meta font-semibold text-text-primary">
                          <Star size={11} className="text-accent-warning" />
                          {review.rating}/5
                        </div>
                        {review.body && (
                          <p className="mt-1 text-meta leading-relaxed text-text-secondary">{review.body}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
