import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heart, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { describeCommunityError, nextFeedCursor, normalizeFeed } from '@clawwork/core';
import type { CommunityPost } from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmptyState from '@/components/semantic/EmptyState';

type Visibility = 'private' | 'org';

/**
 * 广场。
 *
 * 三条纪律：
 *   ① 所有读写走 `window.clawwork.community*`（→ main → Supabase definer RPC），
 *      权限与可见性由数据库判定，这里**不做第二套判断**；
 *   ② 点赞/评论的计数一律用**服务端返回的真值**，不做本地 +1
 *      （本地 +1 在并发/失败时会和真实值漂开，而且服务端本来就给了真值）；
 *   ③ 失败一律给中文（`describeCommunityError`），界面里不出现机器码或英文。
 */
export default function FeedTab() {
  const { t } = useTranslation();
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('org');
  const [publishing, setPublishing] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

  const load = useCallback(async (before: string | null): Promise<void> => {
    setLoading(true);
    setFailed(false);
    const res = await window.clawwork.communityFeed(before ? { before } : undefined);
    if (!res.ok) {
      setFailed(true);
      setLoading(false);
      return;
    }
    const rows = normalizeFeed(res.result);
    setPosts((current) => (before ? [...current, ...rows] : rows));
    setCursor(nextFeedCursor(rows));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const publish = useCallback(async (): Promise<void> => {
    const body = draft.trim();
    if (!body || publishing) return;
    setPublishing(true);
    const res = await window.clawwork.communityCreatePost({ body, visibility });
    setPublishing(false);
    if (!res.ok) {
      toast.error(describeCommunityError(res.errorCode));
      return;
    }
    setDraft('');
    await load(null);
  }, [draft, visibility, publishing, load]);

  const toggleLike = useCallback(async (postId: string): Promise<void> => {
    const res = await window.clawwork.communityLikeToggle(postId);
    if (!res.ok) {
      toast.error(describeCommunityError(res.errorCode));
      return;
    }
    const liked = res.result?.liked ?? false;
    const likeCount = res.result?.likeCount ?? 0;
    setPosts((current) =>
      current.map((item) => (item.postId === postId ? { ...item, likedByMe: liked, likeCount } : item)),
    );
  }, []);

  const remove = useCallback(async (postId: string): Promise<void> => {
    const res = await window.clawwork.communityDeletePost(postId);
    if (!res.ok) {
      toast.error(describeCommunityError(res.errorCode));
      return;
    }
    setPosts((current) => current.filter((item) => item.postId !== postId));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 space-y-2 border-b border-[var(--border-subtle)] p-4">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('community.composePlaceholder')}
          rows={3}
          className="glow-focus w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-transparent"
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1">
            {(['org', 'private'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={visibility === option}
                onClick={() => setVisibility(option)}
                className="glow-focus rounded-md px-2 py-1 type-support text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--state-selected)] aria-pressed:text-[var(--accent)]"
              >
                {t(option === 'org' ? 'community.composeVisibilityOrg' : 'community.composeVisibilityPrivate')}
              </button>
            ))}
          </div>
          <Button size="sm" disabled={!draft.trim() || publishing} onClick={() => void publish()}>
            {publishing ? t('community.publishing') : t('community.publish')}
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          {loading && posts.length === 0 && (
            <p className="type-support text-[var(--text-muted)]">{t('community.loading')}</p>
          )}

          {failed && (
            <div className="flex items-center gap-2">
              <p className="type-support text-[var(--text-secondary)]">{t('community.loadFailed')}</p>
              <Button size="sm" variant="outline" onClick={() => void load(null)}>
                {t('community.retry')}
              </Button>
            </div>
          )}

          {!loading && !failed && posts.length === 0 && <EmptyState title={t('community.emptyFeed')} />}

          {posts.map((item) => (
            <article key={item.postId} className="rounded-lg border border-[var(--border-subtle)] p-3">
              <header className="mb-1 flex items-center gap-2">
                <span className="type-label text-[var(--text-primary)]">{item.authorName}</span>
                {item.visibility === 'private' && (
                  <span className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 type-support text-[var(--text-muted)]">
                    {t('community.privateBadge')}
                  </span>
                )}
                <span className="flex-1" />
                {item.authorId && (
                  <button
                    type="button"
                    aria-label={t('community.delete')}
                    onClick={() => void remove(item.postId)}
                    className="glow-focus rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </header>
              <p className="whitespace-pre-wrap type-body text-[var(--text-primary)]">{item.body}</p>
              <footer className="mt-2 flex items-center gap-4">
                <button
                  type="button"
                  aria-pressed={item.likedByMe}
                  onClick={() => void toggleLike(item.postId)}
                  className="glow-focus flex items-center gap-1 rounded px-1 type-support text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] aria-pressed:text-[var(--accent)]"
                >
                  <Heart size={14} />
                  {item.likedByMe ? t('community.liked') : t('community.like')} {item.likeCount}
                </button>
                <span className="type-support text-[var(--text-muted)]">
                  {t('community.comments')} {item.commentCount}
                </span>
              </footer>
            </article>
          ))}

          {cursor && posts.length > 0 && (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" onClick={() => void load(cursor)}>
                {t('community.loadMore')}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
