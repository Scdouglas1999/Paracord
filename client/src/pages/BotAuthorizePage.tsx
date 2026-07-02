import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bot, Check, ExternalLink, ShieldAlert, Star } from 'lucide-react';
import { botApi, type PublicBotApplication } from '../api/bots';
import { botStoreApi, type BotReview } from '../api/botStore';
import { extractApiError } from '../api/client';
import { guildApi } from '../api/guilds';
import type { Guild } from '../types';
import { Button } from '../components/ui/Button';

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <div className="rounded-2xl border border-border-subtle bg-bg-secondary/55 p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-primary/15 text-accent-primary">
              <Bot size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-bold text-text-primary">Authorize Bot Application</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Review the bot and choose the server where you want to install it.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-3 text-sm font-medium text-accent-danger"
          >
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-5 py-6 text-sm text-text-muted">
            Loading bot authorization details...
          </div>
        ) : (
          <div className="space-y-4 rounded-2xl border border-border-subtle bg-bg-secondary/55 p-6">
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Application</p>
              <p className="text-sm font-semibold text-text-primary">
                {application?.name || `Bot App ${applicationId}`}
              </p>
              {reviewSummary && (
                <p className="text-xs text-text-muted inline-flex items-center gap-1.5">
                  <Star size={12} className="text-accent-warning" />
                  {reviewSummary.average_rating.toFixed(1)} average ({reviewSummary.review_count} reviews)
                </p>
              )}
              {application?.description && (
                <p className="text-sm text-text-secondary">{application.description}</p>
              )}
              <p className="text-xs text-text-muted">ID: {applicationId}</p>
            </div>

            <div className="space-y-2 rounded-xl border border-border-subtle bg-bg-primary/50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Rate This Bot</p>
              <div className="flex items-center gap-2">
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
                <Button
                  type="button"
                  onClick={() => void submitReview()}
                >
                  Submit Review
                </Button>
              </div>
              <textarea
                className="input-field min-h-20 resize-y"
                aria-label="Review body"
                placeholder="Share your experience (optional)"
                value={reviewBody}
                onChange={(event) => setReviewBody(event.target.value)}
                maxLength={2000}
              />
              {reviews.length > 0 && (
                <div className="max-h-32 space-y-2 overflow-y-auto">
                  {reviews.slice(0, 5).map((review) => (
                    <div key={review.id} className="rounded-lg border border-border-subtle bg-bg-mod-subtle/50 px-3 py-2 text-xs">
                      <div className="font-semibold text-text-primary">
                        {review.rating}/5
                      </div>
                      {review.body && <div className="mt-1 text-text-secondary">{review.body}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Select Server
              </label>
              <select
                className="select-field w-full"
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

            <div className="rounded-xl border border-border-subtle bg-bg-primary/55 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Requested Permissions</p>
              <p className="mt-1 font-mono text-xs text-text-muted">{effectivePermissions}</p>
            </div>

            {authorizedGuildId ? (
              <div className="rounded-xl border border-accent-success/35 bg-accent-success/10 px-4 py-3 text-sm text-accent-success">
                <div className="flex items-center gap-2">
                  <Check size={14} />
                  Bot authorized successfully for server ID {authorizedGuildId}.
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-4 py-3 text-xs text-text-muted">
                <div className="flex items-start gap-2">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                  Only proceed if you trust this bot application and understand the requested permissions.
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              {!authorizedGuildId && (
                <Button
                  className="min-w-[9rem]"
                  onClick={() => void authorize()}
                  disabled={!selectedGuildId || submitting}
                >
                  {submitting ? 'Authorizing...' : 'Authorize'}
                </Button>
              )}

              {authorizedGuildId && effectiveRedirectUri && !continueUrl && (
                <div className="text-xs text-accent-danger">
                  Redirect URL was blocked because it uses an unsafe scheme or does not match the bot's registered URI.
                </div>
              )}
              {continueUrl && (
                <a
                  href={continueUrl}
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                >
                  Continue to App
                  <ExternalLink size={13} />
                </a>
              )}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
