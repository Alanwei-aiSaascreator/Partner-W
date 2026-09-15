# 荣盈魔方万人商业化准备度记忆

**日期：** 2026-09-15  
**用途：** 保存从基本盘 Demo 走向 1 万名 U 盘用户所需的产品、技术、运营和合规结论。本文不替代 Demo 进度汇报。

## 当前判断

- Supabase Pro 的账号额度足以覆盖 1 万月活用户，但套餐人数不等于系统并发能力；正式承诺容量前必须压测。
- Supabase Pro 起价是 25 美元/月，不是 25 元人民币。模型、短信、Relay 服务器、域名/CDN、签名证书和监控另计。
- 当前主要容量风险不是 Supabase MAU，而是单机单进程 Relay、百炼账号级 RPM/TPM、短信峰值和缺少生产监控。
- 当前适合 Demo 与小规模种子用户，不适合直接承诺 1 万人同时使用。

## 已有基础

- Supabase Auth 手机号登录、组织隔离、RLS、激活卡、设备记录、订单、支付、额度和用量账本已经存在。
- 百炼主密钥只在服务器端 Relay 环境中；客户端按账号取得独立 Relay 凭证。
- Relay 不把请求和回复正文写入业务数据库，日志只保留模型、Token、请求标识等元数据。
- Windows 客户端已接入自有 `electron-updater` 更新源，支持检查、下载、进度和安装。
- 模型价格由数据库 `pricing_rules` 与 revision 管理，可在不更新客户端的情况下调整，旧用量不应被新价格追溯重算。

## 关键缺口

### P0：首批付费用户前

1. 将服务条款与隐私政策拆成两个真实、可访问、带版本号的页面。
2. 将用户同意记录持久化：用户、条款版本、隐私版本、同意时间、设备与来源。
3. 梳理手机号、设备、支付、提示词、文件和模型调用的数据流，确认 Supabase 实际区域及数据跨境路径。
4. 本地凭证加密改为失败关闭，禁止 `safeStorage` 失败时回退明文；进一步保护 Gateway 中的 Relay 凭证。
5. 发布带数字签名的 Windows 安装包、`latest.yml`、`.blockmap` 与 SHA-512 校验信息到自有 HTTPS 更新源。
6. 开通 Supabase Pro、费用告警、每日备份，并完成一次恢复演练。

### P1：1000 名真实用户前

1. 建立内部运营后台：账号、激活卡、设备解绑、额度调整、订单退款、价格版本、模型上下架、软件版本和审计。
2. 建立生产监控：Relay 延迟与错误率、Supabase CPU/连接/慢查询、百炼 RPM/TPM/429、短信成功率和支付回调。
3. 增加用户数据导出、删除、注销、撤回同意及客服处理闭环。
4. 对 100、1000、10000 用户场景分阶段压测，记录峰值并发、流式连接、数据库请求量和模型 Token 吞吐。

### P2：1 万用户前

1. Relay 无状态化、多实例部署、负载均衡、健康检查、队列、限流、重试、熔断和灰度回滚。
2. 向百炼申请提额或购买预留 TPM；增加不同供应商的备用上游。多个同主账号 API Key 不视为扩容方案。
3. 将上游成本价与用户销售价分表、分版本管理，保存生效时间、价格来源、审批和回滚记录。
4. 建立 U 盘批次、SKU、卡密、出库、设备替换和售后追踪。

## 更新策略冻结

- 推荐模式：U 盘负责首次交付和安装，安装到电脑后的客户端通过官方 HTTPS 更新源升级。
- 当前不会自动改写 U 盘里的原始安装文件，也不应默认获得这种写入权限。
- 离线客户使用经过签名和校验的离线升级包。
- 正式更新必须支持 stable/beta、灰度比例、失败回滚与最低安全版本。

## 隐私与安全边界

- 本地工作区和聊天数据不是全部应用层加密，目前仍依赖 Windows 账号和磁盘加密；不能宣传为“所有数据端到端加密”。
- 用户提示词及其主动提供的文件内容会经过荣盈 Relay 发送给所选模型供应商；隐私政策必须明确第三方、用途、地区和保存规则。
- 敏感文件访问、电脑工具调用和写入工作区外位置继续保留逐次说明与用户确认。
- Supabase 托管区域没有中国大陆节点。若生产数据位于境外，须完成个人信息保护影响评估并由专业律师确认跨境合规路径。
- 正式上线前需要安全事件响应、密钥轮换、凭证吊销、管理员 MFA/RBAC 和不可抵赖审计。

## 开发顺序

1. 协议页面与同意记录。
2. 本地密钥安全与账号注销/数据权利。
3. 在线更新发布闭环。
4. 最小运营后台。
5. Relay 与上游扩容。

## 参考

- Supabase Pricing: https://supabase.com/pricing
- Supabase Billing: https://supabase.com/docs/guides/platform/billing-on-supabase
- Supabase Regions: https://supabase.com/docs/guides/platform/regions
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- 阿里云百炼模型价格: https://help.aliyun.com/zh/model-studio/model-pricing
- 阿里云百炼限流: https://help.aliyun.com/zh/model-studio/rate-limit
- 《中华人民共和国个人信息保护法》: https://www.npc.gov.cn/WZWSREL25wYy9jMi9jMzA4MzQvMjAyMTA4L3QyMDIxMDgyMF8zMTMwODguaHRtbD9yZWY9aW1i
