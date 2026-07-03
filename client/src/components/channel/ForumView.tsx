import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDownUp,
  Check,
  Grid3X3,
  LayoutList,
  MessageSquare,
  Plus,
  Search,
  Tag,
  X,
} from 'lucide-react';
import { extractApiError } from '../../api/client';
import { channelApi } from '../../api/channels';
import type { Channel, ForumTag, Member, Message } from '../../types';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { useMemberStore } from '../../stores/memberStore';
import { EmptyState, ErrorBanner, LoadingSpinner } from '../ui/Feedback';
import { useFocusTrap } from '../../hooks/useFocusTrap';

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
      map.set(member.user.id, member.nick || member.user.username);
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

  const handleSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const { data } = await channelApi.searchMessages(channelId, trimmed, 50);
      setSearchResults(data);
    } catch (err) {
      toast.error(`Search failed: ${extractApiError(err)}`);
      setSearchResults(null);
    } finally {
      setSearching(false);
    }
  }, [channelId]);

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle/70 px-4 py-3">
        {/* Sort */}
        <button
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-mod-subtle"
          onClick={() => void handleSortChange(sortOrder === 0 ? 1 : 0)}
          title={sortOrder === 0 ? 'Sorted by latest activity' : 'Sorted by creation date'}
        >
          <ArrowDownUp size={14} />
          {sortOrder === 0 ? 'Latest Activity' : 'Newest First'}
        </button>

        {/* Layout toggle */}
        <div className="flex items-center rounded-lg border border-border-subtle">
          <button
            className={cn(
              'flex items-center gap-1 rounded-l-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
              layout === 'grid'
                ? 'bg-bg-mod-strong text-text-primary'
                : 'text-text-muted hover:text-text-secondary',
            )}
            onClick={() => setLayout('grid')}
            title="Grid view"
          >
            <Grid3X3 size={14} />
          </button>
          <button
            className={cn(
              'flex items-center gap-1 rounded-r-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
              layout === 'list'
                ? 'bg-bg-mod-strong text-text-primary'
                : 'text-text-muted hover:text-text-secondary',
            )}
            onClick={() => setLayout('list')}
            title="List view"
          >
            <LayoutList size={14} />
          </button>
        </div>

        {/* Include archived */}
        <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="rounded"
          />
          Archived
        </label>

        {/* Search */}
        <div className="relative flex items-center">
          <Search size={14} className="pointer-events-none absolute left-2.5 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSearch(searchQuery);
            }}
            placeholder="Search posts..."
            className="w-44 rounded-lg border border-border-subtle bg-bg-mod-subtle py-1.5 pl-8 pr-7 text-xs text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-border-strong focus:w-56"
          />
          {searchQuery && (
            <button
              onClick={clearSearch}
              aria-label="Clear forum search"
              className="absolute right-2 text-text-muted hover:text-text-secondary"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="flex-1" />

        <button
          className="flex items-center gap-1.5 rounded-xl border border-border-subtle px-3 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-subtle"
          onClick={() => setShowTagManager(true)}
        >
          <Tag size={15} />
          Tags
        </button>

        {/* New Post button */}
        <button
          className="flex items-center gap-1.5 rounded-xl border border-accent-primary/50 bg-accent-primary/15 px-3.5 py-2 text-sm font-semibold text-accent-primary transition-colors hover:bg-accent-primary/25"
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
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                selectedTags.has(tag.id)
                  ? 'border-accent-primary/60 bg-accent-primary/20 text-accent-primary'
                  : 'border-border-subtle text-text-secondary hover:border-border-strong hover:bg-bg-mod-subtle',
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
              className="text-xs text-text-muted hover:text-text-secondary"
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
            <span className="text-xs font-medium text-text-muted">
              {searching ? 'Searching...' : `${searchResults.length} result${searchResults.length === 1 ? '' : 's'} found`}
            </span>
            <button
              onClick={clearSearch}
              className="text-xs text-text-muted hover:text-text-secondary"
            >
              Clear search
            </button>
          </div>
          {searching ? (
            <LoadingSpinner className="py-12" label="Searching..." />
          ) : searchResults.length === 0 ? (
            <EmptyState
              className="py-16"
              icon={<Search size={28} />}
              title="No results found"
              description="Try a different search query"
            />
          ) : (
            <div className="space-y-2">
              {searchResults.map((msg) => (
                <div
                  key={msg.id}
                  className="rounded-xl border border-border-subtle bg-bg-mod-subtle/30 px-4 py-3"
                >
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <span className="font-medium text-text-secondary">
                      {msg.author?.username || 'Unknown'}
                    </span>
                    {msg.created_at && (
                      <span>{new Date(msg.created_at).toLocaleString()}</span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-text-primary line-clamp-3">
                    {msg.content}
                  </p>
                </div>
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
            className="py-16"
            icon={<MessageSquare size={28} />}
            title="No posts yet"
            description={`Be the first to start a conversation in #${channelName}`}
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

      {showTagManager && (
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
      className="group flex flex-col rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-4 text-left transition-all hover:border-border-strong hover:bg-bg-mod-subtle"
    >
      <div className="mb-2 flex items-start gap-2">
        <span className="flex-1 truncate text-sm font-semibold text-text-primary group-hover:text-accent-primary">
          {post.name || 'Untitled'}
        </span>
        {isArchived && (
          <span className="shrink-0 rounded bg-bg-mod-strong px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
            Archived
          </span>
        )}
      </div>

      {matchedTags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {matchedTags.map((tag) => (
            <span
              key={tag.id}
              className="rounded-full border border-border-subtle px-2 py-0.5 text-[10px] font-medium text-text-muted"
            >
              {tag.emoji && <span className="mr-0.5">{tag.emoji}</span>}
              {tag.name}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center gap-3 text-xs text-text-muted">
        {post.owner_id && <span>by {authorName || 'Unknown user'}</span>}
        <span className="flex items-center gap-1">
          <MessageSquare size={12} />
          {post.message_count ?? 0}
        </span>
        <span className="ml-auto">
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
      className="group flex w-full items-center gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/30 px-4 py-3 text-left transition-all hover:border-border-strong hover:bg-bg-mod-subtle"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-text-primary group-hover:text-accent-primary">
            {post.name || 'Untitled'}
          </span>
          {isArchived && (
            <span className="shrink-0 rounded bg-bg-mod-strong px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
              Archived
            </span>
          )}
        </div>
        {matchedTags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {matchedTags.map((tag) => (
              <span
                key={tag.id}
                className="rounded-full border border-border-subtle px-2 py-0.5 text-[10px] font-medium text-text-muted"
              >
                {tag.emoji && <span className="mr-0.5">{tag.emoji}</span>}
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-4 text-xs text-text-muted">
        {post.owner_id && <span>by {authorName || 'Unknown user'}</span>}
        <span className="flex items-center gap-1">
          <MessageSquare size={12} />
          {post.message_count ?? 0}
        </span>
        <span>{new Date(post.created_at).toLocaleDateString()}</span>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true, onClose);

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
    <>
      <div
        className="fixed inset-0 z-50 modal-backdrop"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forum-tag-manager-title"
        tabIndex={-1}
        className="glass-modal fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <h2 id="forum-tag-manager-title" className="text-lg font-semibold text-text-primary">Manage Forum Tags</h2>
          <button
            onClick={onClose}
            aria-label="Close tag manager"
            className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
              placeholder="Tag name"
              className="w-full rounded-xl border border-border-subtle bg-bg-mod-subtle px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-border-strong"
            />
            <input
              type="text"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              maxLength={16}
              placeholder="Emoji"
              className="w-full rounded-xl border border-border-subtle bg-bg-mod-subtle px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-border-strong"
            />
            <button
              onClick={() => void createTag()}
              disabled={creating || !name.trim()}
              className="rounded-xl border border-accent-primary/50 bg-accent-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>

          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {tags.length === 0 ? (
              <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/30 px-4 py-5 text-center text-sm text-text-muted">
                No tags yet.
              </div>
            ) : (
              tags.map((tag) => (
                <div key={tag.id} className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/35 px-3 py-2">
                  <div className="text-sm text-text-primary">
                    {tag.emoji ? `${tag.emoji} ` : ''}
                    {tag.name}
                  </div>
                  <button
                    onClick={() => void deleteTag(tag.id)}
                    disabled={deletingTagId === tag.id}
                    className="rounded-lg px-2.5 py-1 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/12 disabled:opacity-50"
                  >
                    {deletingTagId === tag.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true, onClose);

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
    <>
      <div
        className="fixed inset-0 z-50 modal-backdrop"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forum-new-post-title"
        tabIndex={-1}
        className="glass-modal fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <h2 id="forum-new-post-title" className="text-lg font-semibold text-text-primary">New Post</h2>
          <button
            onClick={onClose}
            aria-label="Close new post dialog"
            className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-text-muted">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="Post title"
              className="w-full rounded-xl border border-border-subtle bg-bg-mod-subtle px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-border-strong"
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-text-muted">
              Content (optional)
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="Write the first message of your post..."
              className="w-full resize-none rounded-xl border border-border-subtle bg-bg-mod-subtle px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-border-strong"
            />
          </div>

          {tags.length > 0 && (
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-text-muted">
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
                      'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                      selectedTagIds.has(tag.id)
                        ? 'border-accent-primary/60 bg-accent-primary/20 text-accent-primary'
                        : 'border-border-subtle text-text-secondary hover:border-border-strong',
                    )}
                  >
                    {tag.emoji && <span className="mr-1">{tag.emoji}</span>}
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-xl border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-mod-subtle"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={!title.trim() || submitting}
            className="rounded-xl border border-accent-primary/50 bg-accent-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create Post'}
          </button>
        </div>
      </div>
    </>
  );
}
