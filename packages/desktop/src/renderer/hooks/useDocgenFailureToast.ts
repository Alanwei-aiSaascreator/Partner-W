import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { docgenFailureToastBody } from '@/lib/docgen-failure-copy';

/**
 * 助手写了 ```` ```docgen ```` 块、但有一份没能变成文件时，弹一条能照着做的提示。
 *
 * ## 为什么必须有
 *
 * 之前这条链**只在主进程 `console.error`**：用户看到助手说"已经放到你的产物里了"，
 * 而右侧产物里什么都没有 —— 那比一条明确的报错糟得多，因为它看起来像我们坏了。
 * 现在排不下的内容会**被拒**（`main/docgen/pptx-layout.ts`），拒了就必须有人说话。
 *
 * ## 为什么抽成 hook 而不是写在 `App.tsx` 里
 *
 * 写在 App 里就只能靠"读代码看着对"来验。抽出来之后，测试可以**挂在一个宿主组件上、
 * 真的把事件推给它、断言 toast 真的出现了** —— 这一族 bug（"handler 写了但页面没反应"）
 * 恰恰是纯 handler 单测抓不到的那种。
 *
 * ⚠️ 一次消息只推一次（主进程侧保证），所以这里一条 toast 就够，不做去重/限流。
 */
export function useDocgenFailureToast(): void {
  const { t } = useTranslation();

  useEffect(() => {
    return window.clawwork.onDocgenFailed((failures) => {
      const body = docgenFailureToastBody(failures, t);
      if (!body) return;
      toast.error(t('docgen.failedTitle'), { description: body });
    });
  }, [t]);
}
