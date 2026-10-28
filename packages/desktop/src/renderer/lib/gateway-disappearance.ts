import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '@/stores/uiStore';
import { toast } from '@/lib/toast';

/**
 * 网关从本机**消失**时给一条说明（U 盘被拔掉、盘符变了、网关被移除…）。
 *
 * ## 缺口是什么
 *
 * `useGatewaySelector` 的回落 effect 会**静默**把 `selectedGwId` 换成另一个网关
 * （那条 effect 的注释自己写着"那是'网关没了'这个更上层的事件的通知缺口，属于另一件事"）。
 * 用户上一秒还在跟 A 盘的助手说话，下一秒界面已经在 B 盘上了 —— 行为本身没错
 * （**已拍：维持既有行为**），缺的是**一句说明**。
 *
 * ## 判据：只看 `gatewayInfoMap` 的**成员变化**
 *
 * - **第一次观测不算**（`previous === null`）：那只是"刚看到地图"，不是"有东西消失了"。
 *   少了这一条，启动时就会弹一句假话。
 * - **不挂 `requestDeferred`**（已拍）：那条判据会在**正常换网关**时也成立，
 *   于是切一下就弹一次、还可能闪。这里只问"这个 id 上一份地图里有、这一份里没了"。
 * - **全没了不报**：那是另一种情况，已经有专门的横条（`ConnectionBanner` 的
 *   「一个网关都没有」+ "添加网关"出口），再来一条 toast 只会重复。
 *
 * ## 出口
 *
 * 走 `lib/toast`（8 秒的 warning 档，比普通 toast 长一点）：它**不动布局、不拦操作**，
 * 也不需要在哪块界面上挂状态。⚠️ 位置（toast / 横条 / 别处）是**产品选择** ——
 * 本轮取最轻、最容易改回去的那一种。
 */

export interface DisappearedGateway {
  id: string;
  /** 消失**前**那个名字（消失后就读不到了）。没有名字时回落成 id —— 不许显示空白。 */
  name: string;
}

type GatewayMapLike = Readonly<Record<string, { name?: string } | undefined>>;

/**
 * 上一份地图里有、这一份里没有的网关。
 *
 * ⚠️ 返回空数组的三种情况都**不是**"漏报"：第一次观测、全没了、只增不减。
 */
export function disappearedGateways(previous: GatewayMapLike | null, next: GatewayMapLike): DisappearedGateway[] {
  if (previous === null) return [];
  // 全没了交给 ConnectionBanner（它本来就有出口）；这里只报"少了一部分"。
  if (Object.keys(next).length === 0) return [];

  const gone: DisappearedGateway[] = [];
  for (const [id, info] of Object.entries(previous)) {
    if (id in next) continue;
    gone.push({ id, name: info?.name?.trim() || id });
  }
  return gone;
}

/** 挂在常驻组件上（工作区壳）即可。同一个网关只报一次。 */
export function useGatewayDisappearanceNotice(): void {
  const gatewayInfoMap = useUiStore((state) => state.gatewayInfoMap);
  const previousRef = useRef<GatewayMapLike | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const gone = disappearedGateways(previousRef.current, gatewayInfoMap ?? {});
    previousRef.current = gatewayInfoMap ?? {};
    for (const gateway of gone) {
      toast.warning(t('connection.gatewayDisappeared', { name: gateway.name }));
    }
  }, [gatewayInfoMap, t]);
}
