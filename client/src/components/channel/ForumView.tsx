import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { entityScopeKey as memberScopeKey } from '../../lib/serverScope';
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
} from 'lucide-react';
import { extractApiError } from '../../api/client';
import { channelApi } from '../../api/channels';
import type { Channel, ForumTag, Member, Message } from '../../types';
import { displayName } from '../../lib/displayName';
import { toast } from '../../stores/toastStore';
import { useMemberStore } from '../../stores/memberStore';
import { usePermissions } from '../../hooks/usePermissions';
import { Permissions, hasPermission } from '../../types';
import { EmptyState, ErrorBanner, LoadingSpinner } from '../ui/Feedback';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Input, Textarea } from '../ui/Input';
import { SearchWell } from '../ui/TextField';
import { formatRowTime } from '../glass/places/model';
import { Kicker } from '../glass/primitives';
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
  const memberScope = useCurrentAccountScope();
  const members = useMemberStore((s) => (guildId ? (memberScope ? s.members.get(memberScopeKey(memberScope, guildId)) : undefined) ?? EMPTY_MEMBERS : EMPTY_MEMBERS));
  const membersLoaded = useMemberStore((s) => (guildId ? (memberScope ? s.membersLoaded[memberScopeKey(memberScope, guildId)] : false) : false));
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const { permissions, isAdmin } = usePermissions(guildId || null);
  const canManageTags = isAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS);

  // Row times are read against the moment the page opened; the list is not a clock.
  const [nowMs] = useState(() => Date.now());
  const [posts, setPosts] = useState<Channel[]>([]);
  const [tags, setTags] = useState<ForumTag[]>([]);
  const [sortOrder, setSortOrder] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layout, setLayout] = useState<ViewLayout>('list');
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
    if (!guildId || !memberScope || membersLoaded) return;
    void fetchMembers(guildId, memberScope);
  }, [guildId, membersLoaded, fetchMembers, memberScope]);

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

  const empty = filteredPosts.length === 0;
  return (
    <div className="glass-forum">
      <div className="glass-page__scroll">
        <div className="glass-forum__bar" role="toolbar" aria-label="Forum controls">
          <Button
            variant="glass"
            size="sm"
            onClick={() => void handleSortChange(sortOrder === 0 ? 1 : 0)}
            title={sortOrder === 0 ? 'Sorted by latest activity' : 'Sorted by creation date'}
          >
            <ArrowDownUp size={14} aria-hidden />
            {sortOrder === 0 ? 'Latest activity' : 'Newest first'}
          </Button>

          <div className="glass-forum__layout" role="group" aria-label="Layout">
            <IconButton
              label="List view"
              size="sm"
              tone="ghost"
              active={layout === 'list'}
              onClick={() => setLayout('list')}
            >
              <LayoutList size={14} aria-hidden />
            </IconButton>
            <IconButton
              label="Grid view"
              size="sm"
              tone="ghost"
              active={layout === 'grid'}
              onClick={() => setLayout('grid')}
            >
              <Grid3X3 size={14} aria-hidden />
            </IconButton>
          </div>

          <label className="glass-forum__archived">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="accent-[var(--accent-primary)]"
            />
            Archived
          </label>

          <span className="glass-forum__spacer" />

          {canManageTags && (
            <Button variant="ghost" size="sm" onClick={() => setShowTagManager(true)}>
              <Tag size={14} aria-hidden />
              Tags
            </Button>
          )}

          {/* The one filled button on the page: what this page is for. */}
          <Button size="sm" onClick={() => setShowNewPost(true)}>
            <Plus size={16} aria-hidden />
            New post
          </Button>
        </div>

        <SearchWell
          type="text"
          label="Search posts"
          placeholder="Search posts…"
          icon={<Search size={16} aria-hidden />}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSearch(searchQuery);
          }}
          className="glass-forum__search"
          shortcut={
            searchQuery ? (
              <Button variant="ghost" size="sm" aria-label="Clear forum search" onClick={clearSearch}>
                Clear
              </Button>
            ) : undefined
          }
        />

        {tags.length > 0 && (
          <div className="glass-forum__tags" role="toolbar" aria-label="Forum tag filters">
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => toggleTag(tag.id)}
                onKeyDown={(event) => handleTagRovingFocus(event, 'filters')}
                data-forum-tag-scope="filters"
                className="glass-tagchip glass-focusable"
                aria-pressed={selectedTags.has(tag.id)}
              >
                {selectedTags.has(tag.id) && <Check size={12} aria-hidden />}
                {tag.emoji && <span>{tag.emoji}</span>}
                {tag.name}
              </button>
            ))}
            {selectedTags.size > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setSelectedTags(new Set())}>
                Clear
              </Button>
            )}
          </div>
        )}

        {/* Search results */}
        {searchResults !== null ? (
          <section aria-label="Search results" className="glass-sec">
            <div className="glass-sec__head">
              <Kicker as="h2" className="glass-sec__kicker">
                Results
              </Kicker>
              <span className="glass-instrument glass-sec__count">
                {searching ? 'Searching…' : searchResults.length}
              </span>
              <span className="glass-sec__aside">
                <button type="button" onClick={clearSearch} className="glass-linkbtn glass-focusable">
                  Clear search
                </button>
              </span>
            </div>
            {searching ? (
              <LoadingSpinner className="py-12" label="Searching…" />
            ) : searchResults.length === 0 ? (
              <EmptyState
                icon={<SearchX size={20} />}
                title="Nothing turned up"
                description={`Nothing matches "${searchQuery.trim()}" in ${channelName} yet. Try fewer or different words.`}
              />
            ) : (
              <div className="glass-forum__list">
                {searchResults.map((msg) => (
                  <button
                    key={msg.id}
                    type="button"
                    onClick={() => handleSearchResultClick(msg)}
                    className="glass-fpost glass-focusable"
                  >
                    <span className="glass-fpost__meta">
                      <span className="glass-fpost__author">{displayName(msg.author)}</span>
                      {msg.created_at && (
                        <time dateTime={msg.created_at} className="glass-instrument">
                          {new Date(msg.created_at).toLocaleString()}
                        </time>
                      )}
                    </span>
                    <span className="glass-fpost__snippet glass-clamp" style={{ '--clamp-lines': 3 } as React.CSSProperties}>
                      {msg.content}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : loading ? (
          <LoadingSpinner className="py-12" label="Loading posts..." />
        ) : loadError ? (
          <ErrorBanner
            className="mt-2"
            message={`Failed to load forum posts: ${loadError}`}
            onRetry={() => void fetchPosts()}
          />
        ) : empty ? (
          <EmptyState
            icon={<MessageSquare size={20} />}
            title={
              selectedTags.size > 0
                ? 'No posts match those tags'
                : `${channelName} is ready for its first thread`
            }
            description={
              selectedTags.size > 0
                ? 'Clear a tag filter, or open a new discussion under one of them.'
                : 'Kick things off — ask a question, share an update, or open a topic the community can rally around.'
            }
            action={
              <Button onClick={() => setShowNewPost(true)}>
                <Plus size={16} aria-hidden />
                Start a discussion
              </Button>
            }
          />
        ) : (
          <section aria-label="Posts" className="glass-sec">
            <div className="glass-sec__head">
              <Kicker as="h2" className="glass-sec__kicker">
                Posts
              </Kicker>
              <span className="glass-instrument glass-sec__count">{filteredPosts.length}</span>
            </div>
            <div className="glass-forum__list" data-layout={layout}>
              {filteredPosts.map((post) => (
                <PostRow
                  key={post.id}
                  post={post}
                  tags={tags}
                  authorName={post.owner_id ? memberNameById.get(post.owner_id) ?? null : null}
                  nowMs={nowMs}
                  onClick={() => handlePostClick(post)}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* New post Modal */}
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

/**
 * One post, as a solid row (docs/glass-spec.md §1.1, §2.4): the title (15/600),
 * its tags as small chips, who started it, how many messages, and when. In the
 * grid layout the same row stands on its own as a card, two to a line. The whole
 * row opens the post, which is a conversation like any other.
 */
function PostRow({
  post,
  tags,
  authorName,
  nowMs,
  onClick,
}: {
  post: Channel;
  tags: ForumTag[];
  authorName: string | null;
  nowMs: number;
  onClick: () => void;
}) {
  const postTags: string[] = (post.applied_tags as string[] | null) ?? [];
  const matchedTags = tags.filter((t) => postTags.includes(t.id));
  const isArchived = post.thread_metadata?.archived === true;
  const created = Date.parse(post.created_at);
  const when = Number.isFinite(created) ? formatRowTime(created, nowMs) : null;
  const count = post.message_count ?? 0;

  return (
    <button type="button" onClick={onClick} className="glass-fpost glass-focusable" data-archived={isArchived ? '' : undefined}>
      <span className="glass-fpost__top">
        <span className="glass-name glass-fpost__title">{post.name || 'Untitled'}</span>
        {isArchived && <span className="glass-fpost__flag">Archived</span>}
      </span>
      {matchedTags.length > 0 && (
        <span className="glass-fpost__tags">
          {matchedTags.map((tag) => (
            <span key={tag.id} className="glass-fpost__tag">
              {tag.emoji ? `${tag.emoji} ` : ''}
              {tag.name}
            </span>
          ))}
        </span>
      )}
      <span className="glass-fpost__meta">
        {post.owner_id && <span className="glass-fpost__author">{authorName || 'Unknown user'}</span>}
        <span className="glass-fpost__count" aria-label={`${count} ${count === 1 ? 'message' : 'messages'}`}>
          <MessageSquare size={13} aria-hidden />
          <span className="glass-instrument">{count}</span>
        </span>
        {when && (
          <time dateTime={post.created_at} className="glass-instrument glass-fpost__when">
            {when}
          </time>
        )}
      </span>
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
      labeledBy="forum-tag-manager-title"
      showCloseButton
      closeLabel="Close tag manager"
    >
      <ModalHeader>
        <ModalTitle id="forum-tag-manager-title">Manage forum tags</ModalTitle>
      </ModalHeader>
      <ModalBody className="space-y-4 pb-6">
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
              placeholder="Tag name"
              aria-label="Tag name"
            />
            <Input
              type="text"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              maxLength={16}
              placeholder="Emoji"
              aria-label="Emoji"
            />
            <Button size="lg" onClick={() => void createTag()} disabled={creating || !name.trim()}>
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </div>

          <div className="max-h-64 overflow-y-auto pr-1">
            {tags.length === 0 ? (
              <p className="px-1 py-4 text-body text-text-secondary">
                No tags yet — create one above to help people filter posts by topic.
              </p>
            ) : (
              <div className="flex flex-col">
                {tags.map((tag) => (
                  <div key={tag.id} className="flex items-center justify-between py-1.5">
                    <div className="glass-body text-text-primary">
                      {tag.emoji ? `${tag.emoji} ` : ''}
                      {tag.name}
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void deleteTag(tag.id)}
                      disabled={deletingTagId === tag.id}
                    >
                      {deletingTagId === tag.id ? 'Deleting…' : 'Delete'}
                    </Button>
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
      labeledBy="forum-new-post-title"
      showCloseButton
      closeLabel="Close new post dialog"
    >
      <ModalHeader>
        <ModalTitle id="forum-new-post-title">New post</ModalTitle>
      </ModalHeader>
      <ModalBody className="space-y-4">
          <div>
            <label htmlFor="forum-post-title" className="glass-kicker mb-1.5 block text-[var(--ink-3)]">
              Title
            </label>
            <Input
              id="forum-post-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="What's this discussion about?"
              autoFocus
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <label htmlFor="forum-post-content" className="glass-kicker text-[var(--ink-3)]">
                Opening message (optional)
              </label>
              <span className="glass-instrument text-[13px] text-[var(--ink-3)]">{content.length}/2000</span>
            </div>
            <div className="mb-2">
              <MarkdownToolbar textareaRef={contentRef} onContentChange={setContent} />
            </div>
            <Textarea
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
              className="resize-none"
            />
            <p className="glass-secondary mt-1.5">
              This becomes the first message in the post. Markdown formatting is supported.
            </p>
          </div>

          {tags.length > 0 && (
            <div>
              <div className="glass-kicker mb-1.5 block text-[var(--ink-3)]">Tags</div>
              <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Post tag selection">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    onKeyDown={(event) => handleTagRovingFocus(event, 'composer')}
                    data-forum-tag-scope="composer"
                    aria-pressed={selectedTagIds.has(tag.id)}
                    className="glass-tagchip glass-focusable"
                  >
                    {selectedTagIds.has(tag.id) && <Check size={12} aria-hidden />}
                    {tag.emoji && <span>{tag.emoji}</span>}
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          )}
      </ModalBody>
      <ModalFooter className="mt-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void handleSubmit()} disabled={!title.trim() || submitting}>
          {submitting ? 'Creating…' : 'Create post'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
