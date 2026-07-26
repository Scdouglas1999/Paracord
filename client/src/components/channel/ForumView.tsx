import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  ArrowDownUp,
  Check,
  Grid3X3,
  LayoutList,
  MessageSquare,
  Plus,
  Search,
  SearchX,
  Tag,
  X,
} from 'lucide-react';
import { extractApiError } from '../../api/client';
import { channelApi } from '../../api/channels';
import type { Channel, ForumTag, Member, Message } from '../../types';
import { cn } from '../../lib/utils';
import { displayName } from '../../lib/displayName';
import { toast } from '../../stores/toastStore';
import { useMemberStore } from '../../stores/memberStore';
import { usePermissions } from '../../hooks/usePermissions';
import { Permissions, hasPermission } from '../../types';
import { EmptyState, ErrorBanner, LoadingSpinner } from '../ui/Feedback';
import {
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../ui/Modal';
import {
  applyMarkdownToolbarAction,
  MarkdownToolbar,
  resolveMarkdownShortcut,
} from '../message/MarkdownToolbar';

interface ForumViewProps {
  channelId: string;
  channelName: string;
}

type ViewLayout = 'grid' | 'list';

const EMPTY_MEMBERS: Member[] = [];

function handleTagRovingFocus(event: KeyboardEvent<HTMLButtonElement>, scope: string) {
  const key = event.key;
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return;
  const root = event.currentTarget.ownerDocument;
  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>(`button[data-forum-tag-scope="${scope}"]`),
  );
  if (buttons.length === 0) return;
  const currentIndex = buttons.indexOf(event.currentTarget);
  if (currentIndex < 0) return;

  event.preventDefault();
  let targetIndex = currentIndex;
  if (key === 'Home') targetIndex = 0;
  if (key === 'End') targetIndex = buttons.length - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    targetIndex = (currentIndex + 1) % buttons.length;
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    targetIndex = (currentIndex - 1 + buttons.length) % buttons.length;
  }
  buttons[targetIndex]?.focus();
}

export function ForumView({ channelId, channelName }: ForumViewProps) {
  const { guildId } = useParams();
  const navigate = useNavigate();
  const members = useMemberStore((s) => (guildId ? s.members.get(guildId) ?? EMPTY_MEMBERS : EMPTY_MEMBERS));
  const membersLoaded = useMemberStore((s) => (guildId ? s.membersLoaded[guildId] : false));
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const { permissions, isAdmin } = usePermissions(guildId || null);
  const canManageTags = isAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS);

  const [posts, setPosts] = useState<Channel[]>([]);
  const [tags, setTags] = useState<ForumTag[]>([]);
  const [sortOrder, setSortOrder] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layout, setLayout] = useState<ViewLayout>('grid');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [showNewPost, setShowNewPost] = useState(false);
  const [showTagManager, setShowTagManager] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Message[] | null>(null);
  const [searching, setSearching] = useState(false);

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) {
      map.set(member.user.id, displayName(member.user, member.nick));
    }
    return map;
  }, [members]);

  const fetchPosts = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const { data } = await channelApi.getForumPosts(channelId, {
        sort_order: sortOrder,
        include_archived: includeArchived,
      });
      setPosts(data.posts || []);
      setTags(data.tags || []);
    } catch (err) {
      const message = extractApiError(err);
      setLoadError(message);
      toast.error(`Failed to load forum posts: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [channelId, sortOrder, includeArchived]);

  const fetchTags = useCallback(async () => {
    try {
      const { data } = await channelApi.getForumTags(channelId);
      setTags(data || []);
    } catch {
      // Tag permissions can fail for users without access; keep existing tags.
    }
  }, [channelId]);

  useEffect(() => {
    void Promise.all([fetchPosts(), fetchTags()]);
  }, [fetchPosts, fetchTags]);

  useEffect(() => {
    if (!guildId || membersLoaded) return;
    void fetchMembers(guildId);
  }, [guildId, membersLoaded, fetchMembers]);

  const filteredPosts =
    selectedTags.size === 0
      ? posts
      : posts.filter((post) => {
          const postTags: string[] = (post.applied_tags as string[] | null) ?? [];
          return postTags.some((t) => selectedTags.has(t));
        });

  const toggleTag = (tagId: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const handlePostClick = (post: Channel) => {
    if (guildId) {
      navigate(`/app/guilds/${guildId}/channels/${post.id}`);
    }
  };

  const handleSortChange = async (newOrder: number) => {
    setSortOrder(newOrder);
    try {
      await channelApi.updateForumSortOrder(channelId, newOrder);
    } catch (err) {
      toast.error(`Failed to save forum sort order: ${extractApiError(err)}`);
    }
  };

  const searchGenerationRef = useRef(0);

  const handleSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      searchGenerationRef.current += 1;
      setSearchResults(null);
      setSearching(false);
      return;
    }
    const generation = ++searchGenerationRef.current;
    setSearching(true);
    try {
      const { data } = await channelApi.searchMessages(channelId, trimmed, 50);
      if (generation !== searchGenerationRef.current) return;
      setSearchResults(data);
    } catch (err) {
      if (generation !== searchGenerationRef.current) return;
      toast.error(`Search failed: ${extractApiError(err)}`);
      setSearchResults(null);
    } finally {
      if (generation === searchGenerationRef.current) {
        setSearching(false);
      }
    }
  }, [channelId]);

  const clearSearch = () => {
    searchGenerationRef.current += 1;
    setSearchQuery('');
    setSearchResults(null);
    setSearching(false);
  };

  const handleSearchResultClick = (msg: Message) => {
    if (!guildId) return;
    navigate(`/app/guilds/${guildId}/channels/${msg.channel_id}?message=${msg.id}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-3">
        {/* Sort */}
        <button
          className="flex items-center gap-1.5 rounded-sm border border-border-subtle px-3 py-1.5 text-label font-medium text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          onClick={() => void handleSortChange(sortOrder === 0 ? 1 : 0)}
          title={sortOrder === 0 ? 'Sorted by latest activity' : 'Sorted by creation date'}
        >
          <ArrowDownUp size={14} />
          {sortOrder === 0 ? 'Latest activity' : 'Newest first'}
        </button>

        {/* Layout toggle */}
        <div className="flex items-center overflow-hidden rounded-sm border border-border-subtle">
          <button
            className={cn(
              'flex items-center gap-1 px-2.5 py-1.5 text-label font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
              layout === 'grid'
                ? 'bg-bg-mod-strong text-text-primary'
                : 'text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary',
            )}
            onClick={() => setLayout('grid')}
            title="Grid view"
            aria-pressed={layout === 'grid'}
          >
            <Grid3X3 size={14} />
          </button>
          <button
            className={cn(
              'flex items-center gap-1 px-2.5 py-1.5 text-label font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
              layout === 'list'
                ? 'bg-bg-mod-strong text-text-primary'
                : 'text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary',
            )}
            onClick={() => setLayout('list')}
            title="List view"
            aria-pressed={layout === 'list'}
          >
            <LayoutList size={14} />
          </button>
        </div>

        {/* Include archived */}
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-meta text-text-muted">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="accent-[var(--accent-primary)]"
          />
          Archived
        </label>

        {/* Search */}
        <div className="relative flex items-center rounded-sm border border-border-subtle bg-bg-tertiary transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-within:border-accent-primary focus-within:shadow-[var(--focus-ring-input)]">
          <Search size={14} className="pointer-events-none absolute left-2.5 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSearch(searchQuery);
            }}
            placeholder="Search posts…"
            className="w-44 bg-transparent py-1.5 pl-8 pr-7 text-meta text-text-primary placeholder:text-text-muted outline-none transition-[width] duration-[180ms] ease-[var(--ease-out)] focus:w-56"
          />
          {searchQuery && (
            <button
              onClick={clearSearch}
              aria-label="Clear forum search"
              className="absolute right-2 text-text-muted outline-none transition-colors hover:text-text-secondary focus-visible:text-text-primary"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="flex-1" />

        {canManageTags && (
          <button
            className="flex items-center gap-1.5 rounded-sm border border-border-subtle px-3 py-2 text-label font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
            onClick={() => setShowTagManager(true)}
          >
            <Tag size={15} />
            Tags
          </button>
        )}

        {/* New Post button — primary emerald */}
        <button
          className="flex items-center gap-1.5 rounded-sm bg-accent-primary px-3.5 py-2 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:bg-accent-primary-active focus-visible:shadow-[var(--focus-ring)]"
          onClick={() => setShowNewPost(true)}
        >
          <Plus size={16} />
          New Post
        </button>
      </div>

      {/* Tag filters */}
      {tags.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle/50 px-4 py-2"
          role="toolbar"
          aria-label="Forum tag filters"
        >
          <Tag size={13} className="text-text-muted" />
          {tags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => toggleTag(tag.id)}
              onKeyDown={(event) => handleTagRovingFocus(event, 'filters')}
              data-forum-tag-scope="filters"
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-meta font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                selectedTags.has(tag.id)
                  ? 'border-transparent bg-accent-tint text-accent-primary'
                  : 'border-border-subtle text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
              )}
              aria-pressed={selectedTags.has(tag.id)}
            >
              {selectedTags.has(tag.id) && <Check size={11} aria-hidden />}
              {tag.emoji && <span className="mr-1">{tag.emoji}</span>}
              {tag.name}
            </button>
          ))}
          {selectedTags.size > 0 && (
            <button
              onClick={() => setSelectedTags(new Set())}
              className="rounded-sm px-1.5 py-0.5 text-meta text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-text-secondary focus-visible:shadow-[var(--focus-ring)]"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Search results */}
      {searchResults !== null && (
        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-meta text-text-muted">
              {searching
                ? 'Searching…'
                : `${searchResults.length} result${searchResults.length === 1 ? '' : 's'} found`}
            </span>
            <button
              onClick={clearSearch}
              className="rounded-sm px-1.5 py-0.5 text-meta text-text-muted outline-none transition-colors hover:text-text-secondary focus-visible:shadow-[var(--focus-ring)]"
            >
              Clear search
            </button>
          </div>
          {searching ? (
            <LoadingSpinner className="py-12" label="Searching…" />
          ) : searchResults.length === 0 ? (
            <EmptyState
              icon={<SearchX size={20} />}
              title="Nothing turned up"
              description={`Nothing matches "${searchQuery.trim()}" in #${channelName} yet. Try fewer or different words.`}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {searchResults.map((msg) => (
                <button
                  key={msg.id}
                  type="button"
                  onClick={() => handleSearchResultClick(msg)}
                  className="rounded-md bg-bg-mod-subtle/50 px-4 py-3 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                >
                  <div className="flex items-center gap-2 text-meta text-text-muted">
                    <span className="font-medium text-text-secondary">
                      {displayName(msg.author)}
                    </span>
                    {msg.created_at && (
                      <span className="font-code tabular-nums">
                        {new Date(msg.created_at).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-3 text-body text-text-primary">
                    {msg.content}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Posts */}
      {searchResults === null && <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
        {loading ? (
          <LoadingSpinner className="py-12" label="Loading posts..." />
        ) : loadError ? (
          <ErrorBanner
            className="mt-2"
            message={`Failed to load forum posts: ${loadError}`}
            onRetry={() => void fetchPosts()}
          />
        ) : filteredPosts.length === 0 ? (
          <EmptyState
            icon={<MessageSquare size={20} />}
            title={
              selectedTags.size > 0
                ? 'No posts match those tags'
                : `#${channelName} is ready for its first thread`
            }
            description={
              selectedTags.size > 0
                ? 'Clear a tag filter, or open a new discussion under one of them.'
                : 'Kick things off — ask a question, share an update, or open a topic the community can rally around.'
            }
            action={
              <button
                onClick={() => setShowNewPost(true)}
                className="flex items-center gap-1.5 rounded-sm bg-accent-primary px-3.5 py-2 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:bg-accent-primary-active focus-visible:shadow-[var(--focus-ring)]"
              >
                <Plus size={16} />
                Start a discussion
              </button>
            }
          />
        ) : layout === 'grid' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredPosts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                tags={tags}
                authorName={post.owner_id ? memberNameById.get(post.owner_id) ?? null : null}
                onClick={() => handlePostClick(post)}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredPosts.map((post) => (
              <PostRow
                key={post.id}
                post={post}
                tags={tags}
                authorName={post.owner_id ? memberNameById.get(post.owner_id) ?? null : null}
                onClick={() => handlePostClick(post)}
              />
            ))}
          </div>
        )}
      </div>}

      {/* New Post Modal */}
      {showNewPost && (
        <NewPostModal
          channelId={channelId}
          tags={tags}
          onClose={() => setShowNewPost(false)}
          onCreated={() => {
            setShowNewPost(false);
            void fetchPosts();
            void fetchTags();
          }}
        />
      )}

      {showTagManager && canManageTags && (
        <TagManagerModal
          channelId={channelId}
          tags={tags}
          onClose={() => setShowTagManager(false)}
          onChanged={() => {
            void fetchTags();
            void fetchPosts();
          }}
        />
      )}
    </div>
  );
}

function PostCard({
  post,
  tags,
  authorName,
  onClick,
}: {
  post: Channel;
  tags: ForumTag[];
  authorName: string | null;
  onClick: () => void;
}) {
  const postTags: string[] = (post.applied_tags as string[] | null) ?? [];
  const matchedTags = tags.filter((t) => postTags.includes(t.id));
  const isArchived = post.thread_metadata?.archived === true;

  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-secondary p-4 text-left shadow-sm outline-none transition-shadow duration-[180ms] ease-[var(--ease-out)] hover:shadow-md focus-visible:shadow-[var(--focus-ring)]"
    >
      <div className="flex items-start gap-2">
        <span className="flex-1 truncate text-subhead text-text-primary transition-colors duration-[140ms] group-hover:text-accent-primary">
          {post.name || 'Untitled'}
        </span>
        {isArchived && (
          <span className="shrink-0 rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta font-medium text-text-muted">
            Archived
          </span>
        )}
      </div>

      {matchedTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {matchedTags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-meta font-medium text-text-muted"
            >
              {tag.emoji && <span className="mr-0.5">{tag.emoji}</span>}
              {tag.name}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {post.owner_id && (
          <span className="text-meta text-text-secondary">by {authorName || 'Unknown user'}</span>
        )}
        <span className="inline-flex items-center gap-1 rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta text-text-secondary">
          <MessageSquare size={12} />
          <span className="tabular-nums">{post.message_count ?? 0}</span>
        </span>
        <span className="ml-auto inline-flex items-center rounded-xs bg-bg-mod-strong px-1.5 py-0.5 font-code text-[11px] tabular-nums text-text-muted">
          {new Date(post.created_at).toLocaleDateString()}
        </span>
      </div>
    </button>
  );
}

function PostRow({
  post,
  tags,
  authorName,
  onClick,
}: {
  post: Channel;
  tags: ForumTag[];
  authorName: string | null;
  onClick: () => void;
}) {
  const postTags: string[] = (post.applied_tags as string[] | null) ?? [];
  const matchedTags = tags.filter((t) => postTags.includes(t.id));
  const isArchived = post.thread_metadata?.archived === true;

  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-md border border-border-subtle bg-bg-secondary px-4 py-3 text-left shadow-sm outline-none transition-shadow duration-[180ms] ease-[var(--ease-out)] hover:shadow-md focus-visible:shadow-[var(--focus-ring)]"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-label font-semibold text-text-primary transition-colors duration-[140ms] group-hover:text-accent-primary">
            {post.name || 'Untitled'}
          </span>
          {isArchived && (
            <span className="shrink-0 rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta font-medium text-text-muted">
              Archived
            </span>
          )}
        </div>
        {matchedTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {matchedTags.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-meta font-medium text-text-muted"
              >
                {tag.emoji && <span className="mr-0.5">{tag.emoji}</span>}
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {post.owner_id && (
          <span className="text-meta text-text-secondary">by {authorName || 'Unknown user'}</span>
        )}
        <span className="inline-flex items-center gap-1 rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta text-text-secondary">
          <MessageSquare size={12} />
          <span className="tabular-nums">{post.message_count ?? 0}</span>
        </span>
        <span className="inline-flex items-center rounded-xs bg-bg-mod-strong px-1.5 py-0.5 font-code text-[11px] tabular-nums text-text-muted">
          {new Date(post.created_at).toLocaleDateString()}
        </span>
      </div>
    </button>
  );
}

function TagManagerModal({
  channelId,
  tags,
  onClose,
  onChanged,
}: {
  channelId: string;
  tags: ForumTag[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingTagId, setDeletingTagId] = useState<string | null>(null);

  const createTag = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      await channelApi.createForumTag(channelId, {
        name: trimmed,
        emoji: emoji.trim() || undefined,
      });
      setName('');
      setEmoji('');
      onChanged();
      toast.success('Tag created');
    } catch (err) {
      toast.error(`Failed to create tag: ${extractApiError(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const deleteTag = async (tagId: string) => {
    setDeletingTagId(tagId);
    try {
      await channelApi.deleteForumTag(channelId, tagId);
      onChanged();
      toast.success('Tag deleted');
    } catch (err) {
      toast.error(`Failed to delete tag: ${extractApiError(err)}`);
    } finally {
      setDeletingTagId(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="auto"
      panelClassName="w-full max-w-lg"
      labelledBy="forum-tag-manager-title"
      showCloseButton
      closeLabel="Close tag manager"
    >
      <ModalHeader>
        <ModalTitle id="forum-tag-manager-title">Manage Forum Tags</ModalTitle>
      </ModalHeader>
      <ModalBody className="space-y-4 pb-6">
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
              placeholder="Tag name"
              className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2.5 text-body text-text-primary placeholder:text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
            />
            <input
              type="text"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              maxLength={16}
              placeholder="Emoji"
              className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2.5 text-body text-text-primary placeholder:text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
            />
            <button
              onClick={() => void createTag()}
              disabled={creating || !name.trim()}
              className="rounded-sm bg-accent-primary px-4 py-2 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:bg-accent-primary-active focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto pr-1">
            {tags.length === 0 ? (
              <p className="px-1 py-4 text-body text-text-secondary">
                No tags yet — create one above to help people filter posts by topic.
              </p>
            ) : (
              <div className="flex flex-col">
                {tags.map((tag) => (
                  <div
                    key={tag.id}
                    className="flex items-center justify-between border-t border-border-subtle py-2.5 first:border-t-0"
                  >
                    <div className="text-body text-text-primary">
                      {tag.emoji ? `${tag.emoji} ` : ''}
                      {tag.name}
                    </div>
                    <button
                      onClick={() => void deleteTag(tag.id)}
                      disabled={deletingTagId === tag.id}
                      className="rounded-sm px-2.5 py-1 text-meta font-semibold text-accent-danger outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-danger hover:text-text-on-danger focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50"
                    >
                      {deletingTagId === tag.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
      </ModalBody>
    </Modal>
  );
}

function NewPostModal({
  channelId,
  tags,
  onClose,
  onCreated,
}: {
  channelId: string;
  tags: ForumTag[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;

    setSubmitting(true);
    try {
      await channelApi.createForumPost(channelId, {
        name: trimmed,
        content: content.trim() || undefined,
        applied_tag_ids: selectedTagIds.size > 0 ? Array.from(selectedTagIds) : undefined,
      });
      toast.success('Post created');
      onCreated();
    } catch (err) {
      toast.error(`Failed to create post: ${extractApiError(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="auto"
      panelClassName="w-full max-w-lg"
      labelledBy="forum-new-post-title"
      showCloseButton
      closeLabel="Close new post dialog"
    >
      <ModalHeader>
        <ModalTitle id="forum-new-post-title">New Post</ModalTitle>
      </ModalHeader>
      <ModalBody className="space-y-4">
          <div>
            <label htmlFor="forum-post-title" className="mb-1.5 block text-section uppercase text-text-muted">
              Title
            </label>
            <input
              id="forum-post-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="What's this discussion about?"
              className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2.5 text-body text-text-primary placeholder:text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
              autoFocus
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <label htmlFor="forum-post-content" className="text-section uppercase text-text-muted">
                Opening message (optional)
              </label>
              <span className="text-meta tabular-nums text-text-muted">{content.length}/2000</span>
            </div>
            <div className="overflow-hidden rounded-sm border border-border-subtle bg-bg-tertiary focus-within:border-accent-primary focus-within:shadow-[var(--focus-ring-input)]">
              <div className="border-b border-border-subtle bg-bg-secondary px-2 py-1">
                <MarkdownToolbar textareaRef={contentRef} onContentChange={setContent} />
              </div>
              <textarea
                id="forum-post-content"
                ref={contentRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={(event) => {
                  const action = resolveMarkdownShortcut(event);
                  if (!action || !contentRef.current) return;
                  event.preventDefault();
                  applyMarkdownToolbarAction(action, contentRef.current, setContent);
                }}
                maxLength={2000}
                rows={5}
                placeholder="Give people enough context to join the discussion…"
                className="w-full resize-none bg-transparent px-3 py-2.5 text-body leading-relaxed text-text-primary placeholder:text-text-muted outline-none"
              />
            </div>
            <p className="mt-1.5 text-meta text-text-muted">
              This becomes the first message in the post. Markdown formatting is supported.
            </p>
          </div>

          {tags.length > 0 && (
            <div>
              <label className="mb-1.5 block text-section uppercase text-text-muted">
                Tags
              </label>
              <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Post tag selection">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    onKeyDown={(event) => handleTagRovingFocus(event, 'composer')}
                    data-forum-tag-scope="composer"
                    aria-pressed={selectedTagIds.has(tag.id)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-meta font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                      selectedTagIds.has(tag.id)
                        ? 'border-transparent bg-accent-tint text-accent-primary'
                        : 'border-border-subtle text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
                    )}
                  >
                    {tag.emoji && <span className="mr-1">{tag.emoji}</span>}
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          )}
      </ModalBody>
      <ModalFooter className="mt-2 border-t border-border-subtle">
        <button
          onClick={onClose}
          className="rounded-sm border border-border-subtle px-4 py-2 text-label font-medium text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
        >
          Cancel
        </button>
        <button
          onClick={() => void handleSubmit()}
          disabled={!title.trim() || submitting}
          className="rounded-sm bg-accent-primary px-4 py-2 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:bg-accent-primary-active focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create Post'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
