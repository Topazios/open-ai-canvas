**公共任务运行时实施与验收手册**

状态：待实施。配套规格为 `docs/plans/task-runtime-implementation-plan.md`。本手册给出固定依赖、逐批改动、检查与回退方式；所有 R0–R9 项目均尚未实施，不以现有类似能力当作新方案验收完成。

**1. 执行总原则**

每一批都必须包含真实调用入口、对应合同/数据变化、最小充分验证和阶段记录。尽量把一批拆成一到三个可审查改动，避免一次修改全部画布 Hook、Worker、Provider 和账务。批次间保留可用的应用。

实施时先检查 git status 与适用 AGENTS.md；当前工作区有其他未提交修改，不覆盖、不回滚、不清理。新公共逻辑放新文件，旧文件只做必要接线或删除已完成迁移的逻辑。新文件不得只是透传包装而没有隔离职责。

阶段标识与开关规则：

- **schemaVersion=1** 是新提交合同，不意味着已经切换执行运行时。
- **runtimeVersion=0** 表示旧执行生命周期，允许有关联的新 TaskSpec/Command 回执。
- **runtimeVersion=2** 表示新 Runner/Lifecycle，任务接受后固定，不随页面或 feature flag 变化。
- **nativeExecutorKinds** 决定未来新任务中哪些类型可以使用 runtimeVersion=2；不追溯修改已领取任务。
- **legacy_dispatcher/new_dispatcher** 是集群部署模式；任何阶段都只有一个调度体系拥有领取权。
- **eventCoverage** 是观察 DTO 字段：legacy_snapshot/admission_only/full。R2 只保证新受理事务中的初始事件，R4 接入统一状态写入后才承诺完整生命周期事件。

**2. 阶段依赖与交付**

```mermaid
flowchart LR
  R0[R0 基线与合同] --> R1[R1 图片构造器]
  R1 --> R2[R2 可靠提交]
  R2 --> R3[R3 真实监控页]
  R3 --> R4[R4 执行与交付生命周期]
  R4 --> R5[R5 调度器接管]
  R5 --> R6[R6 服务端批次计划]
  R6 --> R7[R7 异步上游执行]
  R7 --> R8[R8 其余入口迁移]
  R8 --> R9[R9 清理与发布验收]
```

| 阶段 | 可见交付 | 本批不承担的变更 | 依赖 |
| --- | --- | --- | --- |
| R0 | 入口清单、版本/状态/身份合同、基线 | 不迁移运行时 | 无 |
| R1 | 普通图片通过纯构造器形成请求 | 不改队列和计费 | R0 |
| R2 | 回执丢失可安全重放、参数快照 | 不启用第二个 Worker | R1 |
| R3 | 新页面查看真实任务与运行详情 | 不伪造旧任务等待原因 | R2 |
| R4 | 图片进入新 Runner，恢复/副作用可靠 | 不同时重写所有供应商协议 | R2、R3 |
| R5 | 公共调度器成为唯一领取入口 | 不改变所有任务的上游在途口径 | R4 |
| R6 | 批次关页面后继续，暂停/依赖可观察 | 不替代 Agent 动态规划 | R5 |
| R7 | 异步提交/查询分离且容量受控 | 不凭 TTL 假定上游已经结束 | R4、R5、R6 |
| R8 | 视频、音频、文本、Agent 等全部接入 | 不取消原有批准/费用校验 | R7 |
| R9 | 旧链路退场、恢复/发布验证完成 | 独立 Worker 部署作为后续可选项 | R8 |

R0–R3 是第一个完整可交付范围：已经有公共构造、可靠受理和真实观察，但执行仍可复用旧生命周期。R4–R7 完成公共运行时与持久编排。R8–R9 完成全入口迁移和旧实现退场。

**3. R0：基线、行为和合同冻结**

新增/整理：contract 的值对象草案、入口迁移清单、样例夹具；暂不在生产注册新运行时。

执行步骤：

1. 复核普通图片、批量图片、视频、音频、文本流、短剧分批、章节、创作页、Agent/CreationSubmission、时间线，以及各自重试/取消入口。
2. 记录 Task.ID、RouteRun、RouteAttempt、ProviderRequestID、订单、outputIndex、effectKey 的关系；明确 legacy text_replay 和 Agent 根载体不是普通付费生成。
3. 记录现有计费/状态事务的锁顺序、租约检查位置及发布事件位置，作为新事务适配依据。
4. 固定 TaskIntent、TaskSpec、ExecutionSpec、TaskReceipt、TaskView、DispatchDecision 的字段和版本含义。
5. 制作可复现的非敏感输入/预期输出夹具：每种媒体、无/多引用、首尾帧、mask、不同模型选择、结构化文本、失败/取消/未知提交/保存失败。
6. 在实施验证范围内记录现有测试和小规模队列指标基线；没有运行条件时记录未验证项，不虚构吞吐。

完成条件：每个入口有明确的迁移目标；同一事实的归属与身份没有重复定义；新合同不会接受客户端自报的用户、批准或非计费权限。

回退：仅新增合同和夹具，不改变运行行为。

**4. R1：纯构造器与单图片路径**

新增：`web/src/lib/task-runtime` 的合同门面与 image builder、`services/task-runtime/resource-preparer.ts`、画布 image/input 适配器；后端公共合同导出与对应样例。

必要旧接线：`canvas-image-generation-executor.ts` 中构造请求的部分进入新适配器；节点创建、布局、选择与结果展示保留原业务入口。旧 API 仍可接收 adapter 转换出的 CreateTaskInput。

执行步骤：

1. 画布适配器从稳定节点/配置/引用快照提取输入；资源准备单独执行。
2. ImageBuilder 只输出规范 Intent，无网络、随机数和 store 依赖。
3. LegacyRequestAdapter 将 Intent 映射到旧请求合同；供应商字段仍使用现有协议与配置解析。
4. 对选定入口做新旧构造影子比较，只比较对象，不同时发送两次真实请求。比较应保留引用顺序、operation、模型选择和有效参数。
5. 新构造路径通过后只开启该普通图片单任务入口；未迁移分支明确保持原路径。

验证：合同正反例；构造输入不被修改；同输入产出相同 Intent；风格/技能/引用/模型限制行为与基线一致；图片结果绑定同一目标。

完成条件：一条真实图片链路已经使用新 builder；页面不再手写该入口的后端 payload；已有生成次数和计费语义不变。

回退：关闭该入口使用新 builder 的接线，任务仍由原系统执行。保留对比夹具。

**5. R2：可靠提交、回执与不可变快照**

新增：submission 模块、task_specs/task_commands/task_runtime_events/task_event_streams 模型和迁移；taskruntime repository 受理事务；task runtime HTTP 路由和 service 别名；前端 client 与 pending-submissions。

必要旧接线：从 CreateTask 抽出可复用的 Prepare/Commit，最终事务复用现有 finance/容量判断；原接口保持现有授权边界。新接口创建的试点任务此时仍可设置 runtimeVersion=0，由旧 Worker 执行。

执行步骤：

1. 先落可向前兼容的新增表/字段及 schema 注册，测试空库与已有库升级。
2. 实现规范化和请求哈希；已有 key 查询早于会变化的目录/报价解析，同键不同语义返回明确冲突。
3. 将唯一操作键、Task、Spec、订单预占、回执和初始事件纳入一个事务。
4. 为内部创作/Agent 批准入口预留授权端口，但本批不将它们改接公开通用 API。
5. SDK 在操作开始时创建 key，保存冻结请求和回执；HTTP 超时只查原 key 或用原 key 重放。
6. 将普通图片试点入口改接新 submit；回执得到即结束提交等待，观察单独进行。

验证矩阵：

| 注入位置 | 预期 |
| --- | --- |
| 唯一 key 已争取、Task 未创建 | 事务回滚，不留下可误判成功的回执。 |
| 预占后、Task 插入前 | 一并回滚，不留下孤立预扣。 |
| Task/Spec/回执保存成功、HTTP 响应丢失 | 原 key 重放返回原 Task，一次预占。 |
| 两个并发请求同 key 同参数 | 返回同一已提交身份，无第二个账单。 |
| 同 key 不同参数/引用顺序/目标 | idempotency_conflict。 |
| 模型目录在首次成功后变化 | 重放返回旧回执，不重新报价/生成。 |

完成条件：数据库约束和事务保障幂等；不能只靠前端 Map。监控 DTO 标记 admission_only，后续 legacy 执行状态仍由快照补齐，不能宣称全生命周期原子事件已经完成。

回退：关闭 submissionV2Enabled；已创建任务照常由旧 Worker 完成，新表和回执保留。最低回退代码能读取已登记 schema，不能回退到 schema 检查不兼容的二进制。

**6. R3：监控接口与真实页面**

新增：observation 模块、legacy observation adapter、查询/聚合/attempts/events 接口；用户 `/tasks/monitor`、管理员 `/admin/task-runtime` 页面与共享详情组件。

必要旧接线：router、工作区/管理员导航与对应功能权限；旧任务中心提供进入监控的入口，仍保留历史页面。

执行步骤：

1. 用新 DTO 映射 legacy Task、RouteAttempt、执行详情、日志和现有类别策略；旧数据无法确定的原因返回 unknown。
2. 后端实现过滤和游标分页，聚合使用同一权限与过滤定义；前端不从 30 条记录计算总队列。
3. 构建概览、筛选、任务表和详情抽屉；先接真实 API，再增加管理员 Worker/资源快照。
4. 建立共享事件订阅和断流恢复；legacy_snapshot/admission_only 任务保留低频查询补全。
5. 接入现有取消/重试/保存恢复的命令适配，所有按钮由 allowedActions 控制；不能从浏览器直接修改状态。legacy 使用原状态条件，不能依赖虚构的 stateVersion；收费重试尚未实现回执/世代/账务原子幂等时不开放该操作。
6. 打开列表和详情不执行素材同步或画布回填；这些仍由业务消费者负责。

验证：分页无重复/遗漏的稳定历史用例；实时状态移动的刷新策略；统计范围；无权限/账号切换；断流重连；过期事件游标；取消与费用确认；空态/错误/加载/窄屏/明暗主题。页面验证必须在实际路由上完成。

完成条件：用户可看到每条真实任务的阶段、等待原因可用性、尝试和结果；管理员可看资源快照及更新时间。未迁移字段如实缺省，未使用虚构数据作为验收。

回退：关闭 monitorEnabled 或隐藏新导航；任务执行完全不受页面是否打开影响。

**7. R4：图片执行生命周期、状态机与交付**

新增：execution runner/registry、lifecycle、delivery/effects、RouteAttempt 执行快照扩展、task_effects 迁移、账务/资源/画布桥接。TaskRuntimeFields 基础版本字段已在 R2 创建，本批补充执行所需字段并启用新状态规则。开始让新的图片任务使用 runtimeVersion=2。

必要旧接线：旧 dispatcher 已领取任务后按 runtimeVersion 分派；version=0 调用旧完整处理链，version=2 调用新 Runner。新 Runner 的 legacy provider wrapper 只调用协议/路由核心，不再嵌套旧 processClaimedTask。

执行步骤：

1. 提取状态迁移表和 Lifecycle.Transition，所有 v2 状态写路径带 stateVersion、RouteRun；Worker 写入另加租约 Owner/Epoch，用户命令使用授权条件。Queue 的纯租约维护与业务状态变化分开，后者必须调用同一迁移规则。
2. 实现续租、超时、取消注册、leaseLost 隔离；保留现有独立续租 context 修复。
3. 提交前固定 ExecutionSpec，并原子更新 RouteAttempt dispatch checkpoint；已接受/未知任务按原事实恢复。
4. 上游输出先落恢复记录；由 ResultDelivery 完成保存与登记，失败进入交付恢复。
5. 终态决定与待办 effects 同事务；账务效果委托原账本幂等操作。旧 Worker 已失去租约时不能触发账务 effect。
6. 接入现有画布消费者并显示 binding 状态；逐步增加后端绑定端口，但不强行一次迁走所有前端 materializer。
7. v2 状态变化与关键事件实现同事务；DTO 对该类任务标记 full。

验证：续租失败与执行超时分别注入；任务被重新领取后旧 writer 不能提交；submit checkpoint 前后崩溃；accepted 回执恢复；unknown 不重发；输出保存/登记/ack 失败后复用；取消与完成竞争；结算失败后补偿不重复结算；旧任务仍可执行。

完成条件：普通图片在真实入口通过新 Runner；公开行为与既有业务一致；监控显示完整生命周期事件与保存状态；有代码证据证明没有双续租、双终态、双账务链。

回退：停止创建新的 v2 图片，但保留已验证的新 Runner 或 bridge binary 处理已接收 v2 任务。不得把运行中任务 runtimeVersion 改回 0。

**8. R5：公共调度器接管**

新增：queue/scheduler、eligibility、fairness、调度 scope 表与迁移、资源快照适配。此阶段仍保持现有长任务占用语义。

执行步骤：

1. 新 Queue adapter 复用 Task 表与原子领取语义，显式处理 runtimeVersion、类别、NextPollAt、scheduleState 和租约。
2. 将旧 dispatcher 的唤醒、类别限额、领取、排空封装为新 dispatcher；legacy 任务继续进入原执行适配器。
3. 保持原类别协调 key，验证两个版本不会各获得一套独立容量。
4. 在功能开关关闭时做只读调度决策比较：候选 ID、原因、策略版本；影子模式不得实际领取或调用上游。
5. 先以 FIFO 等价策略切换唯一 dispatcher，再逐步开启用户轮转、优先级老化与等待原因。
6. 实现长时间等待、无进展、容量满与策略读取错误的真实诊断；相同原因事件合并。

验证：多实例不能领取同一 Task；同类别上限正确；降低上限不取消在途；Redis/数据库不可用时不绕过保护；用户公平性；渠道拥堵不永久阻塞其他可运行渠道；等待事件不产生写放大；排空停止新领取。

完成条件：生产接线仅有新 dispatcher；旧循环不再启动；数据与许可口径连续；候选决策能在监控页解释。

回退：停止新 dispatcher 领取并完成排空/恢复交接后，恢复经过验证的 bridge dispatcher。双方不能重叠领取；v2 Runner 保持可用。

**9. R6：持久批次与依赖计划**

新增：plan 模块、三张计划表/迁移、计划 API、画布 batch-import adapter 与计划详情。

执行步骤：

1. 创建静态 DAG 合同：节点键、模板、依赖输出绑定、失败策略和预算授权引用。
2. 实现计划验证、冻结输入、暂停/继续/取消命令、计划版本控制。
3. Coordinator 按就绪节点有界物化子 Task；操作键稳定，物化与 taskId 绑定同事务。
4. 实现 parent/child 事件推进和定期修复扫描；父流程不长期占模型执行槽位。
5. 将一个新的批量图片入口直接创建服务端 Plan，关闭页面验证持续执行。
6. 导入旧批次：先持久设置 importing 屏障并停止本地新增，核对已有任务回执；服务端用唯一 sourceBatchId 接管归属，旧、新入口均检查归属。只为确定未提交的项目生成子任务；导入成功后保存 serverPlanId，响应丢失用原 import key 恢复。不能遵守屏障的旧客户端批次先排空再迁移。
7. 接入分镜图前置帧等真实依赖；共享事实依赖保留多消费者语义。

验证：刷新/关页/后端重启；无环；重复 plan 创建与导入；先后依赖和结果版本；暂停后不新增、在途可完成；取消只作用于授权的独占子任务；前后端不能同时提交同一批次项；等待项不预扣，创建子任务时预算不足进入需处理状态。

完成条件：至少一个真实批次全程由后端推进，监控可查看未启动/运行/完成/失败及阻塞关系；旧前端调度只服务未导入批次。

回退：停止新计划接收，保留 PlanCoordinator 排空已接收计划，或持久暂停等待恢复。不得恢复已导入批次的浏览器调度。

**10. R7：异步提交、查询与在途容量**

新增：执行器能力合同完善、task_provider_reservations、scope 容量检查、poll/reconcile/cancel 动作，先接一个已有可靠异步回执的视频协议。

执行步骤：

1. 提交前获取持久 provider reservation；登记与 RouteAttempt 关联，存储阶段与容量范围。
2. Submit 返回回执即落库，Runner 保存 Pending/NextPollAt 并释放短期 Worker/HTTP 许可。
3. 下一轮执行 Poll 只查询原回执；终态完成或确认取消才释放 durable 在途许可。
4. unknown 保留占用并进入核对；周期恢复器检查在途回执和孤立 reservation，不能仅靠过期时间释放未知远端任务。
5. 在途名额满时仍能调度已接受任务的 Poll/Cancel/Delivery；禁止再次申请新提交名额导致无法清空。
6. 受控切换该类别的旧长占用口径：先盘点并排空，再启用新容量规则；不把旧 workers 上限与新 provider 上限各算一份。

验证：长时视频不阻塞查询/交付；进程崩溃后不重复提交；Redis 许可丢失后 durable 在途记录仍有效；策略降低上限；unknown/取消未确认；远端完成但本地状态未存的恢复；费用和 RouteRun 不因轮询变化。

完成条件：该异步协议可跨重启继续，实际在途上限与页面一致，短期执行槽位的释放不会导致远端任务超发。

回退：关闭新异步提交，保留新 Poll/Recovery 直到在途许可归零；不得将已有 Pending Task 改回首次 submit。

**11. R8：全部入口逐类迁移**

按顺序接入：其余图片模式 → 视频与音频 → 普通文本流 → 结构化文本/短剧分批 → 创作页/项目章节 → 重试入口 → Agent/智能创作 → 时间线与任务中心创建。

每类执行同一检查清单：

1. 确认输入与结果目标，不把页面对象传入公共 builder。
2. 迁移准入权限、模型/工具/格式规则、预算与批准，不因公共接口而省略。
3. 复用公共提交和命令身份，保持旧 Task/订单/回执关联。
4. 接入 Executor 能力、检查点、错误分类与结果消费者。
5. 验证真实创建、刷新恢复、取消、重试、保存失败与监控详情。
6. 删除已无调用的旧构造/提交分支，或给仍需历史解码的适配器标注范围和最终删除条件。

文本必须保留独立的文本增量序列、Last-Event-ID、草稿归并、结构化结果校验和订阅取消语义。通用任务事件不能替代 token 流。

Agent/CreationSubmission 必须通过内部端口传入已验证的批准上下文；复用现有 generationId、approvalId、预算与唯一 Task 关联。根控制面和每次模型调用分别观察，根任务不新增计费。

自定义渠道由敏感提交适配器承接：保护凭据，server request hash 能区分凭据上下文变化，公开事件不含渠道秘密。协议插件与 workflow provider 仍走现有能力检查。

时间线渲染/转写通过独立 executor 保留本地工具、媒体资源和计费边界。不能因为统一类型分派就走无模型配置的“成功兜底”。

完成条件：迁移矩阵每个入口都有实际调用证据和专项验收结果，所有重试/恢复路径也已迁移。只迁移正常创建路径不算完成。

回退：按入口关闭新任务创建，已接收任务仍固定原 runtime/executor 版本；保留最小必要历史解码与批准回执。

**12. R9：旧实现退场与发布验收**

执行步骤：

1. 用 rg 搜索旧 builder、直接 createGenerationTask 和旧调度入口的剩余调用方；逐项说明合法保留原因或删除。
2. 确认没有两个状态机、两套账务结束逻辑、两个批次推进器、两个同范围 SSE 发布回路。
3. 保留任务身份与历史记录，清理临时影子比较和只用于迁移的可关闭代码。
4. 在 PostgreSQL + Redis 验证多实例领取、续租、故障接管、幂等与事件游标；SQLite 单测不能代替该项。
5. 用非收费桩执行队列规模、慢渠道、多用户公平性、断线重连和故障注入基线比较。
6. 完成真实页面验收、文档与部署 Runbook，记录最低可回退版本和仍在执行任务的版本分布。
7. 如本批修改后端，按仓库脚本构建、排空并重启，验证 ready、新进程和构建时间，不能以“测试通过”代替加载新程序。

完成条件：规范中的全入口、状态一致性、关闭页面持续执行、结果/计费幂等和监控可解释性均有验收证据；已无未说明的旧运行路径。

**13. 建议拆分的可审查改动**

| 改动 | 内容 | 主要验收证据 |
| --- | --- | --- |
| 01 | 合同和迁移矩阵 | 合同样例、身份/状态映射。 |
| 02 | 图片 builder 与 adapter | 新旧参数离线比较、真实单任务。 |
| 03 | 基础迁移与受理事务 | schema 升级、唯一键、事务失败注入。 |
| 04 | SDK 回执与 pending submission | 回执丢失、同键重放。 |
| 05 | 查询/聚合/观察 DTO | 分页、范围、legacy 数据精度。 |
| 06 | 监控用户/管理员页 | 真实路由及权限/错误/重连。 |
| 07 | 图片 Runner 与状态机 | 租约隔离、cancel/complete 竞争。 |
| 08 | 持久 effects 与结果交付 | 保存/登记/账务 ack 失败恢复。 |
| 09 | 单调度器接管 | 领取等价、多实例、容量口径。 |
| 10 | 公平调度与等待原因 | 多用户分布、原因事件与性能。 |
| 11 | Plan API/Coordinator | DAG、稳定子任务键、预算、暂停。 |
| 12 | 画布批次迁移 | 关页继续、重复导入、无双提交。 |
| 13 | 异步视频与在途许可 | submit/poll 分离、崩溃恢复。 |
| 14 | 文本/音频/项目入口 | 各类专项行为与结果归属。 |
| 15 | Agent/自定义渠道/时间线 | 批准预算、凭据保护、非模型语义。 |
| 16 | 退场、故障演练、发布 | 全入口调用搜索、跨进程与真实页面验收。 |

这是一份拆分建议，实际可以合并小改动，但不能跳过相应验收。工作量受当前未提交变更、协议数量和业务入口验收影响；在 R0 后估算，不预先承诺固定天数。

**14. 验证命令与环境约束**

以下命令是在对应实现存在后执行的计划，不是本轮已执行的结果。按改动范围选择最小充分集合，失败后先定位再扩大范围。

后端在 `backend` 目录：

```powershell
go generate ./internal/taskruntime/contract
go test ./internal/taskruntime/...
go test ./internal/repository -run 'TaskRuntime|TaskLease|TaskProvider|TaskConcurrency'
go test ./internal/app -run 'TaskRuntime|TaskWorker|TaskDeadline|TaskRetry|TaskMedia|TaskRoute'
go test ./internal/database -run 'TaskRuntime|Schema|Migration'
```

测试命名在新文件中明确对应以上筛选；执行后确认确实运行了目标测试，不能把“无匹配测试”的通过当验收。涉及账务、资源和权限时补现有相关专项；R9 再跑批准范围内的集成与全量回归。

前端在 `web` 目录，新增专项文件建议：

```powershell
bun test test/task-runtime-contract.test.ts test/task-runtime-builders.test.ts
bun test test/task-runtime-submission.test.ts test/task-runtime-observation.test.ts
bun test test/task-runtime-plans.test.ts test/task-runtime-migration.test.ts
bun run build
```

UI 依赖和项目构建统一使用 Bun，不另行创建 npm/pnpm 锁文件。跨数据库验证使用独立测试数据目录与假供应商，不连接用户生产任务库进行破坏性测试。

Windows 后端源码改动交付前，在仓库根目录按实际活动任务情况执行：

```powershell
.\scripts\backend-local.ps1 status
.\scripts\backend-local.ps1 restart -Build
.\scripts\backend-local.ps1 status
```

等待脚本完成排空并确认 ready、`canvas-backend.exe` 新进程、构建时间晚于源码修改。只编写本方案文档时不执行这些命令，也不启动服务。

**15. 每批交付记录模板**

```text
批次：R__ / 改动 __
状态：未开始 / 实施中 / 已验证 / 待用户验收
接入的真实入口：
新增公共模块与文件：
旧入口必要修改：
schema/runtime/executor 版本：
数据库迁移与开关：
已运行验证及结果：
未验证项与原因：
运行中的服务版本/重启证据（涉及后端时）：
已接收任务的排空/恢复方式：
回退目标与最低兼容版本：
本批可以删除的旧实现：
下一批前置条件：
```

实现过程中同步 `overview/features.mdx`、`backend/code-map.mdx`、`backend/backend-database.mdx`、`backend/http-api.mdx`、`progress/todo.mdx`、`progress/pending-test.mdx` 及任务运行专题。未实现的提案不写成已完成能力；未由用户确认的实现记录为待验收。

本轮完成的是本手册及完整实施规格，尚未开始 R0–R9 的代码实施。
