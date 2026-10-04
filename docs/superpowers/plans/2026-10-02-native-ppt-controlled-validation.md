# A原生模板受控产品验证实施计划

用户2026-10-02本轮评审是实施依据。采用已有隔离工作树，新分支codex/native-ppt-controlled-validation；基线d8662038，原63/21/1准备保留。按executing-plans在当前线程逐项执行，不默认增加代理，不合并/切生产默认。

**目标：** 在原exec/process及成果链里加入受控native工具，强制字段/最终版本对账；只有获准账户和总预算明确后才做真实模型三场景验证。

**架构：** 复用原docgen templateId/data、automizer和PptxGenJS原生对象；复用已有隔离Electron命令、严格workspace读、工具帧/receipt、SQLite reconcile和artifact delivery结算。不新建Agent/任务/认证/账本。测试开关ROYIN_NATIVE_PPT_VALIDATION=1，缺省关闭；原Skill默认、v4、R6保持。

| 切片与文件                                                           | 修改目的                                                                              | 复用能力                                                                                        | 验证                                                                                   | 回退                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| 生命周期证据（QA lifecycle-audit.md，不改全局调度）                  | 分开消息文本结束/模型运行结束/交付结束，定位收尾异步执行者                            | 原session-sync→persist-message→finalizeAssistantArtifacts；claimed run/owner/activity/reconcile | 源码事件顺序与已有实际工具帧，不用模型自述；真实终端部分缺授权则未验证                 | 只移除QA/开关，不改事件内核                 |
| pptx-template/parse.ts及受控controlled.ts                            | 同schema只允许首批cover/insight/metrics/closing；有限柱图直接映射库数据，明确容量拒绝 | 原字段白名单/DocgenFailure；ChartType.bar+name/labels/values                                    | 真模板输入、坏类型/单位/标签、越容量；v4原测试保留                                     | 默认parser不启受控；关开关，移除新字段支持  |
| resources/pptx-templates/business-deck-v5.pptx与build-controlled.mjs | 公司v4资源的公共字体/框/空占位修订；不修单份稿                                        | 原公司native对象/母版，保留v4与blank-root；固定适配层                                           | 原模板与v5SHA；实际导出/对象查验/替代预览；108句全保留                                 | 仅新v5删出候选，v4不改                      |
| pptx-template/fill.ts及render.ts受控参数                             | 只在v5显式分支隐藏空块、写输出页码、放native chart/table                              | Automizer.generate+modify/removeElement；PptxGenJS.addChart/addTable                            | 真实c:chart/embeddedXLSX/a:tbl、图表数值/单位/图例；原v4回归                           | 受控参数默认false，不修改生产默认           |
| docgen/native-file.ts + main/entry.ts及原render-command.ts/helper    | 模型在轮exec拿真实生成/必执行内容对账与限次修订结果；受控命令不用用户DB/Gateway       | 原isolated command/source reader/helper profile/timeout/progress                                | 原真实随包exec/process；输出/缺资源/坏字段；三版本链封顶；不开用户profile              | 关测试开关，旧--royin-render-slidegen仍原路 |
| slidegen/receipt.ts + tool-receipts.ts + data-handlers.ts            | 绑定源快照/模板/检查/最终SHA；native不重生，不冒充visual/Office通过，保持正确run登记  | 原receipt、任务/session/run过滤、sourceKey/baseline/owner/reconcile                             | 换成品/资源、旧run/重复回调、停止取消无新登记；真实SQLite在私有库                      | 关闭受控读取，不动旧receipt分支或消息writer |
| 控制资料与验证记录（QA目录）                                         | 首任务只有版本事实资料，不预置页级内容；再美化、经营数据、允许提炼培训                | 原Gateway/composer→Relay用量及账本；最多两次自动修订                                            | 实际Skill读取、模型名、调用、事件、两版文件及最终逐页PNG；vision能力及Office各自报状态 | 无费用授权不发送；不新增收费服务/账号       |
| 有限修订/停止/费用关联                                               | 每请求与task/run关联，重复ACK和新修订不同；stop后禁新调用，未知usage待核定            | 原chat.abort/artifact run cancel/relay report_usage_v3                                          | 正常链后优先模拟停止/预算耗尽/缺资源；收费不足先停                                     | 不启新admission生产开关、不修改账本历史     |

- [x] 读取用户评审、接续、模块规则；核对d866/准备归属并保存baseline。
- [x] 保留已有worktree，创建受控隔离分支。
- [x] 记录事件顺序、执行者和现有费用边界；模型闭环及金额门禁明确未完成。
- [x] 先写受控原生输入/真实导出失败断言，跑RED，再补最小校验/模板/成熟库映射，跑GREEN与v4回归。
- [x] 本轮工具命令/receipt/来源检查，先RED后实现；受控开关关闭和资源缺失回归。
- [x] 模拟本地停止与重复登记；对可执行local部分做来源/最终SHA/检查对账，不用模拟替代真实模型。
- [ ] 核实真实账户/资料/型号/总费用上限。缺失则完成本地交付并列批准项，停在付费请求前。
- [ ] 有授权时原真实用户任务和再美化两版，再经营/培训；单次最多两轮纠正，总预算同时限制，未获usage不填0。
- [x] 分项交付本地文件/内容/视觉未执行/Office/费用；保存首次失败与所有版本，不自动默认切换。

停止扩范围条件：若PPT运行要求新全局调度器/Agent/认证/账本或重写排版引擎，则记录实际阻点，不自行实施。实际Model/vision调用授权、停止上游费用和预算硬限制若现入口不能保证，应明确未完成，不能用Skill约定替代。

执行测试命令从本机既有 F:/程序/node.exe、pnpm/vitest入口运行，每个slice保存退出码/JSON，不用套件数量当终端验收。复用test/pptx-template-{parse,fill,catalog,render}.test.ts、test/slidegen-tool-receipts.test.ts及现有IPC真实SQLite夹具；以实际存在文件为准。不更改7个原准备format差异。

本轮结束状态：本地13套件262通过，源/test tsc、lint/格式、架构和diff检查通过；实际OpenClaw工具14/1/1页及父链，私有SQLite登记3/重复0/停止0，PowerPoint16打开/另存重开及16页原生预览，108句原文件与重开副本保持。真实模型、自动视觉、Task金额硬门禁、上游停止/用量联测均未完成。账户/预算问讯待答，停在付费前；不新增框架或默认切换。源工作区原63/21准备保留。详见根deliverables/native-ppt-controlled-validation-20261002/REPORT.md。
