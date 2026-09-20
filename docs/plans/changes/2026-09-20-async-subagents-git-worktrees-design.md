# Design: 异步 Subagent Executor 与原生 Git Worktree

Status: approved_for_implementation；用户已明确批准，建议接口与行为以实际交付记录为准。

Date: 2026-09-20。

Repository / baseline: `CsHeng/pi-extensions@12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd`。

Host baseline: Pi 0.86.0。Portable counterpart: `agent-skills@67d15db7e559b9b0abf5a33328cb7355064c6690`。

Companion: [implementation plan](2026-09-20-async-subagents-git-worktrees-plan.md)。

## XD-01. 目标、已定边界与本设计选择

目标是缩短完整 impl plan 的 time-to-accepted。费用是可接受预算内的优化维度，不以最少 token、parent 忙碌程度或 child 数量作为成功指标。Main 确保目标忠实执行并拥有集成、审查裁决与验收；subagents 是既有 workflow 的 executor，不是另一个语义 orchestrator。

已定：允许 parent/child 与 child/child 并行；写任务各自隔离；同任务续接复用；初始写区可在 goal 内扩展；不要求 parent clean；不自动 apply、accept 或语义 repair；不用 sandbox 时不把私有 Git 元数据当安全边界；close-change 涵盖执行资源 disposition。

本设计进一步选择：使用用户仓库的普通 linked worktree，默认 detached；用 Git 原生 checkpoint 保存 parent 可见输入，包含 dirty 源码；不按 initial write set 裁剪输入；只在创建与显式 refresh 边界同步；用 Git 原生三方计算集成，不保留第二套通用文件 merge engine。

旧研究的 no-background 与不可变 exact-write 目标被本设计明确替代。旧文档中的安全、持久状态与验证承诺须逐条保留、缩窄或标记 superseded，不能将历史实现细节当作永远不能变的约束。

## XD-02. 核实到的当前结构

`ContinuationService` 当前持有单一 active/completion，create/continue 等待整个 scheduler 与 child；busy gate 除 inspect 外覆盖 mutation。因此不是只修改一个 return 就能实现并发提交。[R1]

当前 worker 初始输入复制 parent 实际 tracked / non-ignored 文件内容，包括 dirty；后续同步和 candidate export 依赖固定 writePaths 与自行维护的文件状态。计划中的 Git backend 是替换这些通用机制，不是额外包一层目录。[R2][R3]

workflow 目前从 `tool_execution_start/end` 捕获关联事实并在 `agent_settled` 请求主代理继续。异步 submission 返回不再代表 execution finished，必须修正这种关联，并处理“只剩 child 在跑”的正常等待。[R4]

Pi 0.86.0 已公开 `sendMessage` 的 steer / followUp 与 idle trigger，以及 session 生命周期事件；保留这些原语，不引入第二个模型循环。[H1]

## XD-03. 责任与范围

| Owner | 负责 | 不负责 |
| --- | --- | --- |
| Main | goals、分解、派发/续接决定、文件依赖 join、review 裁决、apply 与验收。 | 手工维护 executor 内部版本和进程账本。 |
| Workflow | 义务、attempt 与 evidence 关联、waiting / ready / fulfilled 区分、continuation eligibility。 | 启动 child、替代 main 选择修复或直接合并文件。 |
| Executor | 会话内运行队列、取消、工作区、输入/候选身份、通知、显式 apply/close。 | 读取 Skill/plan 编译任务、改模型配置、自动语义恢复。 |
| Pi | parent loop、模型调用、工具与消息边界、会话持久化。 | 自动理解 extension 的全部外部任务完成语义。 |
| Git | worktree、对象、差异、合并与资源登记。 | 任意 shell sandbox、业务正确性、任务接受和外部环境隔离。 |

保持固定 explorer/reviewer/worker roles 与现有 route 配置语义；不增加 scout 动态角色、模型排行榜或自动购买/替换模型。复用现有 child runner/native history，不迁移到 Nico 全套 runner、missions 或 workflowScript。

首轮支持当前普通 Git 源码仓、Pi TUI/RPC 内的 session-scoped async。源码根需为有效 Git 仓。没有 HEAD 的新仓可沿用同一 Git 原语从 empty/current tree 创建不写入用户分支的 root checkpoint，不应仅因尚无首个业务 commit 拒绝任务。未解决 index conflict 或未支持的特殊 checkout 不与普通 dirty 混为一谈，应返回具体能力限制。Print/一次性宿主若不能维持安全 re-entry，则使用同一 executor 的显式 foreground join 行为并披露 effective mode，不能返回 async handle 后静默退出。此范围不包含进程退出后的 durable jobs。

## XD-04. Dirty 输入：固定版本，而不是持续 cp

### 为什么不只同步 initial write set

一个 worker 不修改的类型、配置、依赖声明或生成输入，仍可能影响其实现和测试。Initial write set 是预测写入区域，不是完整 read dependency set。自动推断“哪些 dirty 无关”本身会引入更多调查和语义逻辑，也会制造 main 看一套、worker 看混合一套的输入。

默认使用一个可解释规则：新写任务看到捕获时 parent 的完整可见源码版本。包含 tracked 文件的当前工作树内容与普通 non-ignored untracked 文件；不继承 index 的暂存分类。Ignored dependencies / caches 走环境准备，而不是偷偷进入源码 checkpoint。文件数量/大小沿用合理现有限制，不为节省一点复制推导未知 read set。

只有 parent 明确指定已有 immutable baseline 时才从该版本启动；这能复用之前批次输入，但不是新增自动 dirty relevance 分类器。无需为了普通派发让用户 commit/stash。

### Git 原生 capture

以 Git CLI 构建薄封装：使用独立临时 index，以 parent 当前有效 index 的跟踪集合为起点，再按工作树可见内容更新；不能只从 HEAD 出发而漏掉已 staged 的新文件。`write-tree` 后用 `commit-tree` 建立本地输入 checkpoint，保存在 executor 命名空间 `refs/csheng/subagents/...`；`git worktree add --detach` 从它创建任务工作区。[G1][G2]

对 staged-delete-but-file-present 等情况遵循同一可见源码规则：仍作为 non-ignored 输入存在的文件要进入基线；被忽略且已不在当前跟踪集合的文件属于环境/显式输入，不隐式添加。基线不是把 parent 暂存区原样当输入。已有未解决的 Git merge/index conflict 与普通 dirty 不同，不能把 conflict markers 当作已解决源码悄悄捕获。Capture 不改 parent HEAD、当前 branch、index、stash 或工作文件，不跑用户提交 hook，不 push。用户没有配置 author identity 时仅给该内部 plumbing 命令提供本地标识，不写全局 config。

这些是临时 Git 对象，不是往用户分支增加业务 commit；但确实会在 common Git directory 增加对象、refs 和 worktree 登记，实施批准必须覆盖这些本地副作用。不得宣称完全没有 Git 写入，也不新增自定义内容 hash 协议。

同一个 create 批次共享一次 capture。任务排队后仍使用已登记输入，不悄悄换成启动时更新的文件；报告中的 base identity 使 parent 能判断是否应刷新。

### Capture 的并发边界

它不是对外部任意 writer 的原子文件系统快照。Parent 发起 capture/apply 时短暂停止自己的相关源码写入；同一 parallel tool batch 的 parent 文件 mutation 与输入 capture 需要在正常 host 边界协调，不能声称有全系统互斥。

其他 children 在独立 worktree 工作不受影响。外部编辑或后台命令与 capture 冲突时报告受影响操作，让 parent 重试或显式固定 checkpoint；不扫描所有进程、不建立全局文件锁服务、不为了此问题要求整个 impl plan clean。

## XD-05. 多轮输入与候选的两个版本

每项写任务保留 `inputBase` 与当前 workspace/candidate 版本。Worker 变更始终定义为相对于它实际收到的 inputBase 的差异，不能用 parent HEAD 作为差异基线，否则会把继承的 dirty 当成 worker 新成果。

普通 `continue` 保留同一 native history、任务 worktree 与原输入版本。只有 parent 已获得相关新输入或需要接收前置集成结果时，才显式请求刷新输入；首轮不在每次续接时无条件扫描/同步整个 parent。这是相对旧实现的有意变化。

刷新发生在该任务没有 writer 的 episode 边界。先冻结已有 worker 结果 W，捕获新的 parent 输入 P；以旧 inputBase B 作基线，使用 Git 三方整合。成功后任务 worktree 为组合结果 M，新的 inputBase 为 P，下一次 candidate 是 P 到后续 worker 结果的变化。不会把 parent 输入再次计入 worker 输出，也不会覆盖尚未应用的 worker 工作。

刷新冲突必须保留 B、W、P。用任务 worktree 的原生 Git conflict state 或可检查的 Git 结果供 main / 原 worker 按已授权目标解决，不在 parent 留 conflict markers，不静默取 ours/theirs。冲突解决属于普通任务修复，不自动要求用户批准；只有真实目标/权限冲突才上报。

Candidate freeze 时确认 child writer 已停、结果完整，并以 Git tree/commit 固定内容。删除、重命名、执行位、普通链接和二进制差异交由 Git 表达；特殊文件、escaping path、未支持 submodule dirty、LFS/filter 等场景按已核实能力报告，不建立自研兼容引擎。普通内部源码 symlink 支持与可越界访问能力不得混淆。

## XD-06. 明确的 parent apply，不把 dirty 清掉

Parent 显式 apply 时：锁定该 candidate 的状态，捕获当前 parent 可见版本 P，以 candidate 的 inputBase B 与 worker 结果 W 计算三方结果 M。使用 `git merge-tree --write-tree --merge-base=B P W` 或同等官方 Git 原语，不使用自研文本合并。[G3]

Exit status 是判断 clean / conflict / error 的依据。输出有 tree OID 不等于成功，不为 conflict 自动生成弱化验收。成功仅表示机械组合成立，main 仍负责组合测试与 acceptance。

发布的差异是 P 到 M，而不是 B 到 W 直接覆盖，也不是将整个 worktree cp 回 parent。可用 `git diff --binary --full-index` 生成差异，经 `git apply --check` 后以 worktree-only `git apply` 发布；不能默认用 `--3way`，因为它隐含 index 契约，会改变与 dirty parent 的关系。[G4]

Apply 保留 parent 的 index 暂存分类与 branch；不执行 parent reset/clean/stash。不相关 parent dirty 保持不变，parent 对旧输入的后续修改/删除也不能被继承基线意外复活。实际集成文件记录在 receipt 中供 workflow 校准 evidence freshness。

同一 parent checkout 的 apply 串行化；其他任务运行不被全局阻塞。Capture 到 publish 之间需要 parent 不写相关文件，Git patch preflight 拒绝不适用的状态。不承诺任意外部 writer 下的事务；实际 I/O 部分失败保留具体证据并暂停该 apply，不自动回滚整棵树或重放。

## XD-07. 写入能力与任务独立性

Worker 的 `writePaths` 过渡为 initial/advisory inventory，允许省略或给已知初始区域。声明明确的 forbidden paths / scope boundary 与 repo ownership 是独立约束；不能把可扩展 initial writes 自动提升成新权限，也不能继续将所有未列文件视为违规。

Native edit/write 的能力覆盖该任务工作区中 goal 允许的源码，禁止通过普通文件工具修改 Git control files、runtime scratch 的归属或越出任务根。可信 bash 仍不是 sandbox。完整 actual changedPaths 来自 candidate 差异，main 对 scope 扩张进行语义验收。

两个独立 worktree 的同名路径不是同一个可变文件资源，不因为 initial writePaths 重叠就机械拒绝并发。真实共享接口、生成器、ports 和外部资源仍可以由 parent 明确串行化。一个任务 worktree 同时只允许一个 writer；reviewer 读取某个 candidate 时使用稳定视图，worker 不同时改变其被审查版本。

## XD-08. Async submission 与会话内调度

`create` / `continue` 以任务被正确登记、不可变源码输入和执行身份确定为返回条件；不等 child 完工。可基于固定输入独立进行的 worktree checkout、依赖准备和 child 启动放入受管准备/排队阶段，不为了等待这些阶段而继续占住 parent tool。准备失败作为该任务的明确终态返回。Return 必须明确区分 submission 接受与 execution phase，保留 handle、episode 和 run association。准确 public field 名在实施 X01 固化，不在文档声称它们已经存在。

保持 `inspect` 为一次状态读取，不要求 sleep/status 循环。增加显式 `cancel` 的 task/run 范围；已有 `/subagents` 命令可增加使用同一 cancel service 的本 owner 取消入口，让用户在 main idle 时也能停止任务，不使只读 UI 拥有调度状态；需要兼容 foreground 时使用同一提交与 join 机制，不维护第二个 executor。旧 action 名称可保留，response/schema version 必须升级以免旧 observation 把 accepted 当 succeeded。

队列归唯一 session-scoped executor 所有。跨 create 调用共享全局与 role capacity、真实 resource locks；不能每个 batch 各领一份完整 concurrency budget。对同 handle 的 continue/apply/close 仍有局部状态约束。移除整个 child 生命周期上的 single mutating batch gate。

独立 child 一旦完结即可发布其结果与 candidate，不等待无关兄弟任务。文件依赖仍须 parent 的显式集成/输入交接；现有 DAG edges 只传报告，不变成文件同步或隐式 reviewer-to-repair 状态机。

提交 request identity 去重继续由现有 store 承担。相同请求重试返回相同运行身份/已知事实，而不是重新启动 child；不声称跨崩溃 exactly-once。

## XD-09. 通知、停止、session 与 Pi 主循环

Completion 顺序为：固定 result / candidate 并保存事实；发布轻量 typed execution event；给原 owner session 排队 compact notification。使用 Pi 0.86.0 `sendMessage(..., {deliverAs:'steer', triggerTurn:true})` 等公开接口。[H1]

忙碌 parent 在宿主正常边界消费消息；idle parent 可恢复一轮处理结果。一个 owner 同时只需要一个待处理 wake，多个近同时 completion 可合并；不做模型轮询、不建立固定间隔提醒。消息不携带 auto-apply 或 acceptance 结论。

Owner 包含 repository、parent session、branch anchor 和运行 generation。正常 leaf 前进与 compaction不等于换 owner；真正 `/tree` 分支替换、session shutdown/reload/new/resume 必须隔离旧事件。根据公开生命周期做清理，不调用 Pi 私有 loop。[H2]

停止行为：显式 cancel 停对应 queued/running work；提交完成后不能仅因原 tool 的 signal 生命周期结束就取消 child。Parent 的明确 abort 或 provider error 使用现有可信 host 分类压制自动唤醒，不能根据一句正文猜测目标取消。若用户取消目标，应通过明确 cancel 关闭相应 children；session shutdown 取消该 owner 的 live children 并等待已有有界清理，保留诊断与未集成成果。

Parent 普通 run 结束不取消 child。`agent_settled` 不代表所有 executor 工作完成。Hard kill 后下次只标记 interrupted/unknown，保留事实，等待显式 reconciliation，不自动恢复模型调用或重新执行未知结果。

Cancellation 被请求、进程已退出、结果已保存是不同事实。沿用候选冻结临界段的 too-late 语义；不得为了取消而破坏已经进入的有限本地 Git 操作。

## XD-10. Workflow 与 executor 的对接

通过小型共享 typed transport contract 对接，不让 workflow 读取 executor 的私有目录。Submission tool result 仅建立 attempt 与 run/handle/episode 的关系；terminal event 或明确 inspect 结果更新执行事实。它们都不是自动 pass / acceptance。

Execution association 必须保留 dispatch 时的 workflow attempt/basis，不能将晚到结果绑定到“当前最新 attempt”或届时才捕获的 parent 输入。Tool-call 结束只是 submission boundary，现有 start/end observation 需要对应调整。[R4]

Workflow 对剩余义务区分：有独立 ready work；等待仍在运行的 child；已有 completed result 待 main 处理；真正 blocked/unknown。只剩 child 时，不发送“继续执行”把 main 唤醒去再次检查 running，也不将正常等待误算成无进展而永久 suspend。

Completion wake 由 executor负责，workflow 对该事件更新 eligibility 并避免再发送同一 continuation。Workflow 自己的非 child 义务继续沿用现有 settlement barrier。只有有理由执行下一步才启动 main，不新增 timer loop。

输入对齐必须能识别受信 transport control event，不把每条 child completion 当作用户改变 goals；child 自然语言始终是未经裁决的 evidence。实际 changedPaths 用于更新 observation / 受影响验证，而不是以 initial write set 固定证据白名单。

## XD-11. 环境、观察与回收

Source checkout 与环境准备分离。尽量复用 `worker-inputs.ts` 中仍有意义的独立 ignored dependencies 与 scratch 逻辑，删除对必须有私有 `.git` 目录的假设。不自动共享可变 node_modules，不默默安装依赖或运行未知 setup hooks；现有项目信任与明确准备方式继续生效。首轮不建设通用容器/缓存服务。

Subagents UI 从 session-scoped运行集合展示 queued / running / completed 等事实，不再绑死当前唯一 tool call。保持 read-only observer，不让 UI 拥有调度或自动 cancel。

Telemetry 区分 submission latency、queue、workspace preparation、child execution、等待理由、apply/repair、whole-goal accepted wall time与费用。异步 tool duration 不再代表 child wall time；避免多次 inspect/notification重复计费。已有 schema 增量扩展，不顺带重写模型路由或 built-in footer 计费。

工作区属于逻辑任务而非 episode。Close 默认不得在结果未保全时删除；`close(discard)` 仅回收 executor 登记拥有的 worktree、scratch 和 namespace refs。Business acceptance 本身不自动执行删除。

采用 detached worktree避免每轮创建普通分支。若实际产生 task branch，记录精确所有权再删除，绝不按模糊前缀清理用户分支。Dirty managed worktree 在明确 discard 且成果按既定 policy 保留后可 force remove；不运行全仓 prune/gc 作为日常 close，也不重建完整恢复平台。

Close-change 将资源标为 reclaimed / explicitly retained / unresolved。UI 可将 retain 原因展示；不增加定时清理 daemon。只要旧运行仍需修复，就保留同任务状态。

## XD-12. 迁移与兼容

新任务统一使用 Git worktree backend，不长期保留 private copy 与 worktree 两套可写策略。旧 private-source records 保持可识别、可 inspect、可显式 retain/discard，旧 native history 不删除。

若用户在旧记录上继续或 apply，返回明确的 legacy-state 说明和可导出成果位置，不自动重放、强制升级或清理；不要把旧 candidate 伪装成拥有新 Git basis。旧运行结果的最小读取/导出兼容不等于维护完整旧 executor。

旧 telemetry / observation 读者保持可读或明确 unavailable；新 schema 不反向制造缺失身份。升级前正常结束当前 runs 是发布说明中的操作步骤，不要求建立在线热迁移引擎。

## XD-13. 验收与范围内验证

| ID | 必须证明的结果 |
| --- | --- |
| X-AC1 | 提交返回时 child 未完成，parent 能再调用工具/提交另一任务。 |
| X-AC2 | 不同调用共享 capacity，一个完成结果不被慢 sibling 挡住。 |
| X-AC3 | parent / worker 文件操作隔离；dirty 源码输入正确继承且 parent index/HEAD 不变。 |
| X-AC4 | candidate 只包括相对自身 inputBase 的修改，不把继承的 dirty 算作新增工作。 |
| X-AC5 | 普通文件新增、删除、重命名等由 Git 表达；超出 initial inventory 的范围内实现可完成。 |
| X-AC6 | 多轮可复用；显式 refresh 保留 worker 修改，冲突不破坏原成果。 |
| X-AC7 | 显式 apply 能组合兼容 parent 漂移，保持 index；冲突/不适用 patch 不覆盖 parent。 |
| X-AC8 | completion 可唤醒同 owner；cancel/session 变化后不会错误重入。 |
| X-AC9 | workflow 不把提交当完成，不因正常等待 spin，不自动接受/修复/apply。 |
| X-AC10 | close 正确保留或回收自有资源，旧记录不会被静默删除。 |
| X-AC11 | UI/telemetry 表达异步事实与真实时间，不伪造费用或重复计数。 |
| X-AC12 | 无额外收益估算器、全新 agent loop、持久任务平台、定时模型轮询。 |

测试使用现有 fake-Pi、受控 deferred child、disposable Git 和必要真实 host RPC probes。直接证明事件顺序与结果，不以 sleep 时长或整机性能阈值证明并发。命中的实际取消/状态迁移要测；不重复所有部署/恢复演练，不强制付费 live 模型来证明工具契约。

## XD-14. 交付与批准

本文完成源码级设计自审，未进行独立 review、运行仓库 tests 或真实模型实验。完整实现后需做一次 targeted review，重点检查 basis / candidate delta、owner / attempt 关联和取消；修复后仅重测受影响证据。

用户后续确认可覆盖：本仓源代码、测试、文档、contracts 的目标内修改；离线依赖安装与验证；disposable Git 操作；本地交付 branch / commits；完整 Git 仓打包。Runtime 的内部 checkpoint / namespace refs / managed worktree 创建回收是本功能正常副作用，需在已批准设计中清楚载明。

不包括：远程 push、npm publish、更新用户安装快照或配置、真实生产/付费 provider 调用、任意用户分支删除。线上实施能力尚受源码完整取得与依赖网络限制，见配套 plan。

## 实施授权记录

2026-09-20：用户批准四份 design/plan，授权在两个仓库副本中实施、运行离线检查、创建本地 Git 提交并返回完整 ZIP。用户随后明确允许 best-effort 交付，受阻项如实记录；不包含远程 push、发布、安装或付费模型调用。

## 来源

读取日期：2026-09-20。源码事实仅指固定 baseline，接口建议和验收是本文设计，不是现有 API 声明。

- [R1 continuation](https://github.com/CsHeng/pi-extensions/blob/12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd/extensions/subagents/continuation.ts)
- [R2 workspace](https://github.com/CsHeng/pi-extensions/blob/12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd/extensions/subagents/workspace.ts)
- [R3 candidates](https://github.com/CsHeng/pi-extensions/blob/12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd/extensions/subagents/candidates.ts)
- [R4 workflow host/observation](https://github.com/CsHeng/pi-extensions/blob/12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd/extensions/workflow/goal-host.ts)
- [R5 managed execution contract](https://github.com/CsHeng/pi-extensions/blob/12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd/docs/architecture/subagent-execution.md)
- [H1 Pi 0.86.0 sendMessage](https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/docs/extensions.md#pisendmessagemessage-options)
- [H2 Pi 0.86.0 session events](https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/docs/extensions.md#session-events)
- [G1 git-worktree](https://git-scm.com/docs/git-worktree)
- [G2 git-commit-tree](https://git-scm.com/docs/git-commit-tree)
- [G3 git-merge-tree](https://git-scm.com/docs/git-merge-tree)
- [G4 git-apply](https://git-scm.com/docs/git-apply)
- [Reference: Nico async implementation, not a dependency](https://github.com/nicobailon/pi-subagents/blob/81885a0/src/runs/background/async-execution.ts)
