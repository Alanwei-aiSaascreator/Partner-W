import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderSearch, ListChecks, MoreHorizontal, Trash2, X } from 'lucide-react';
import mascot from '@/assets/mascot/xiaoying-256.png';

/**
 * 桌面宠物窗口（2026-10-17 用户：可以拖到桌面，帮忙看/整理桌面）。
 *
 * 这个页面只在 `index.html#pet` 那一支渲染（置顶、透明、无边框小窗）。
 * 文件操作全部在主进程（`main/pet/*`）：**整理与删除都会先弹原生确认框**，
 * 删除走回收站 —— 这里只负责说话和播放"吃掉"动画。
 */
export default function PetWindow() {
  const { t } = useTranslation();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [eating, setEating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const eatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineIndex = useRef(0);

  useEffect(() => {
    // 透明窗：页面底色必须跟着透明，否则会得到一个白色方块。
    document.documentElement.classList.add('pet-surface');
    document.body.classList.add('pet-surface');
    return () => {
      document.documentElement.classList.remove('pet-surface');
      document.body.classList.remove('pet-surface');
      if (eatTimer.current) clearTimeout(eatTimer.current);
    };
  }, []);

  /** 点击回应：轮换五句话（前三条与应用内灵宠同一套文案）。 */
  const sayHello = () => {
    const lines = ['mascot.line0', 'mascot.line1', 'mascot.line2', 'pet.line3', 'pet.line4'] as const;
    const key = lines[lineIndex.current % lines.length] ?? 'mascot.line0';
    lineIndex.current += 1;
    setMessage(t(key));
  };

  const playEat = () => {
    setEating(false);
    if (eatTimer.current) clearTimeout(eatTimer.current);
    requestAnimationFrame(() => setEating(true));
    eatTimer.current = setTimeout(() => setEating(false), 900);
  };

  const peek = async () => {
    setBusy(true);
    try {
      const reply = await window.clawwork.petDesktopSummary();
      if (!reply.ok || !reply.result) {
        setMessage(t('pet.peekFailed'));
        return;
      }
      const { fileCount, groups } = reply.result;
      if (fileCount === 0) {
        setMessage(t('pet.desktopClean'));
        return;
      }
      const detail = groups.map((group) => `${group.folder} ${group.count}`).join(' · ');
      setMessage(t('pet.desktopSummary', { count: fileCount, detail }));
    } finally {
      setBusy(false);
    }
  };

  const organize = async () => {
    setBusy(true);
    try {
      const reply = await window.clawwork.petOrganize();
      if (!reply.ok || !reply.result) {
        setMessage(t('pet.organizeFailed'));
        return;
      }
      if (reply.result.cancelled) {
        setMessage(t('pet.cancelled'));
        return;
      }
      setMessage(t('pet.organized', { count: reply.result.moved }));
      playEat();
    } finally {
      setBusy(false);
    }
  };

  const trash = async () => {
    setBusy(true);
    try {
      const reply = await window.clawwork.petTrash();
      if (!reply.ok || !reply.result) {
        setMessage(t('pet.trashFailed'));
        return;
      }
      if (reply.result.cancelled) {
        setMessage(t('pet.cancelled'));
        return;
      }
      setMessage(t('pet.trashed', { count: reply.result.trashed }));
      playEat();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pet-window relative flex h-screen w-screen flex-col items-center justify-end gap-2 p-2">
      {/* 整窗拖拽层（2026-10-18 现场：「拖不动」）。原来只有一条 64×16 的把手是
          `drag`，而用户会去抓**吉祥物**——它带着 `nodrag`（必须，否则点击/右键被
          Electron 吞掉），所以"看着是抓手动，实际拖不动"。这里把整块窗口背景做成
          拖拽区，交互元素仍各自 `nodrag`，于是"除了按钮和吉祥物，哪儿都能拖"。
          ⚠️ 它必须排在最前面且 z-index 最低，交互内容包在 z-10 的层里。 */}
      <div aria-hidden="true" className="drag absolute inset-0 z-0" />
      {/* ⚠️ 这一层必须 `pointer-events-none`：它铺满整窗，若吃掉鼠标事件，
          z-0 的整窗 drag 层永远收不到拖动（2026-10-18 实机：仍旧拖不动）。
          交互元素各自 `pointer-events-auto`。 */}
      <div className="pointer-events-none relative z-10 flex h-full w-full flex-col items-center justify-end gap-2">
        {message ? (
          <div className="pet-bubble nodrag pointer-events-auto max-h-28 overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 type-support leading-relaxed text-[var(--text-secondary)] shadow-[var(--shadow-elevated)]">
            {message}
          </div>
        ) : null}

        <div className="pointer-events-auto flex items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void peek()}
            aria-label={t('pet.peek')}
            title={t('pet.peek')}
            className="nodrag glow-focus rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <FolderSearch size={14} />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void organize()}
            aria-label={t('pet.organize')}
            title={t('pet.organize')}
            className="nodrag glow-focus rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <ListChecks size={14} />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void trash()}
            aria-label={t('pet.trash')}
            title={t('pet.trash')}
            className="nodrag glow-focus rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 text-[var(--text-secondary)] hover:text-[var(--danger)] disabled:opacity-50"
          >
            <Trash2 size={14} />
          </button>
          {/* 吉祥物已经改成可拖区（drag 会吞掉 click / contextmenu），
              菜单入口改由这个按钮承担，右键不再依赖。 */}
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={t('pet.menu')}
            title={t('pet.menu')}
            aria-expanded={menuOpen}
            data-pet-menu-trigger="true"
            className="nodrag glow-focus rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <MoreHorizontal size={14} />
          </button>
          <button
            type="button"
            onClick={() => void window.clawwork.petClose()}
            aria-label={t('pet.close')}
            title={t('pet.close')}
            className="nodrag glow-focus rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <X size={14} />
          </button>
        </div>

        {menuOpen ? (
          <div className="nodrag pointer-events-auto absolute bottom-36 right-2 z-20 w-36 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-elevated)]">
            {[
              ['greet', t('pet.menuGreet'), () => sayHello()],
              ['move', t('pet.menuMove'), () => void window.clawwork.petMove?.()],
              ['peek', t('pet.peek'), () => void peek()],
              ['organize', t('pet.organize'), () => void organize()],
              ['trash', t('pet.trash'), () => void trash()],
            ].map(([key, label, action]) => (
              <button
                key={String(key)}
                type="button"
                data-pet-menu={String(key)}
                onClick={() => {
                  setMenuOpen(false);
                  (action as () => void)();
                }}
                className="glow-focus block w-full rounded px-2 py-1 text-left type-support text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                {label as string}
              </button>
            ))}
          </div>
        ) : null}

        {/*
          ⚠️ 2026-10-18 第三轮实机判断：吉祥物**本身就是最容易被抓的对象**。
          前两轮把它设成 `nodrag`（要接点击/右键），结果是"背景能拖、抓吉祥物还是
          拖不动"。现在放弃"点吉祥物说话"（按钮行与菜单里都有），让它也能拖：
          `drag` + `pointer-events-auto`，菜单改由按钮打开。
        */}
        <img
          src={mascot}
          alt={t('pet.title')}
          width={120}
          height={120}
          draggable={false}
          className={`drag pointer-events-auto cursor-grab select-none ${eating ? 'pet-eat' : 'pet-bob'}`}
        />
      </div>
    </div>
  );
}
