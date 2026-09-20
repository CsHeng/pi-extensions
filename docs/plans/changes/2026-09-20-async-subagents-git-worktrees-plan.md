# Plan: 异步 Subagent 与 Git Worktree 实施交接

Status: approved_for_implementation；用户已提供完整 Git bundle 并批准实施。验证以实际记录为准。

Date: 2026-09-20。

Repository / baseline: `CsHeng/pi-extensions@12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd`。

Design: [异步 executor / worktree 设计](2026-09-20-async-subagents-git-worktrees-design.md)。

Host: Pi 0.86.0。本仓 `package.json` 的开发依赖也为 0.86.0。[P1]

## XP-01. 实施入口与已定目标

新 main 先读本仓 AGENTS、design 和本 plan，再执行。目标是忠实实现 async submission、session-scoped运行、Git worktree 隔离与 dirty 输入、明确集成和资源回收；不是再次比较是否应该采用 Git，也不是迁移到另一套 harness。

旧 AGENTS 的 foreground-only、private .git、exact write set 等约束与新设计冲突的部分，必须在用户批准后有针对性更新。不要让旧约束阻止已批准目标，也不要一并取消真实的 trust / external side-effect / no-auto-accept 边界。

以下路径为初始实施区域，不是不可扩展 write whitelist。遇到必要的邻接 consumer / fixture 可以同目标补改并报告；只有目标、验收或用户保留的权限变化才暂停相关动作。

## XP-02. 实施前最低条件

完整仓库与原始 Git 历史可用；已有未提交修改能识别并保留；Node/npm、Git 与依赖取得能力满足项目工具链。首次运行既有 baseline 检查时记录本来已失败的项目，不能将它们混入改动回归，也不能顺便修全仓。

先确认 Git 支持计划使用的官方 plumbing（特别是 `merge-tree --write-tree` 和显式 merge-base）；按实际可验证版本声明支持范围，不猜最低版本，不写退化自研 merge fallback。普通仓源足够本次目标；未支持的 sparse/submodule/LFS 特殊输入透明返回，不悄悄降级源码内容。

不需要真实 provider 凭据来修改源码与执行 offline tests。不安装用户全局 Pi、不改路由、不自动发布 snapshot。若要真实模型或本机 co-load 验证，另列授权 lane。

## XP-03. 分工与真实依赖

| Task | 目标 | 依赖 | 可并行与归属 |
| --- | --- | --- | --- |
| X01 | 固化最小 async / workspace / event 接口与版本迁移边界。 | 批准本设计。 | Main 负责共享 contracts，避免接口两头各自发明。 |
| X02 | Git checkpoint、任务 worktree、环境准备和动态写入能力。 | X01。 | 可与 X03 并行；Git/workspace 一名 worker。 |
| X03 | 唯一 session supervisor、跨调用容量、提交/取消/续接。 | X01。 | 可与 X02 并行；runtime/lifecycle 一名 worker。 |
| X04 | Git candidate、refresh、三方计算与显式 parent apply。 | X02。 | 优先续接 X02 worker，不为 repair 换人。 |
| X05 | Completion / owner / host-loop re-entry 与停止行为。 | X03，X01 event 接口。 | 可与 X04 并行；优先由 X03 owner 完成。 |
| X06 | Workflow attempt/evidence 关联和 event-driven waiting。 | X01；最终集成需 X05。 | 可先用确定的 fake events 开发，与 X04/X05 并行；独占 workflow 区域。 |
| X07 | 资源 close、旧状态最小兼容、worktree/refs 清理。 | X04、X05。 | Git owner 主做；与 X06 的独立部分并行。 |
| X08 | UI、telemetry、context 投影适配。 | X01、X03；集成需 X05。 | 可按固定 event 接口独立做；不要改 unrelated footer 逻辑。 |
| X09 | 组合回归、官方 host probes、targeted review、稳定文档。 | X02–X08。 | Main 集成；reviewer 只读，repair 返回原 owner。 |
| X10 | 本地 Git 交付版本与两仓交接。 | X09 与相应审批。 | Main 负责；不做 remote push 或用户安装。 |

表中并行是结构预期，不是精确估时或派发命令。不要再为“值不值得派 worker”搜索；依据不足的零碎工作 main 直接完成。一个 worker 负责 cohesive implementation + tests + local repair，不默认将代码和其测试分派给不同 children。

共同写文件由 owner 串行整合。X01 定义小而够用的接口，不要求其先实现全部空骨架，也不让所有任务互相等待全套设计。

## X01. Contracts 与兼容切口

初始区域：`extensions/subagents/session-contracts.ts`、`contracts.ts`、`managed-sessions.ts` 的类型/版本部分；拟新增小型共享 transport event 类型（放在现有 shared 区域，命名由实现选择）。本任务不实现 workspace 或第二个 scheduler。

定义 submission receipt 与 terminal outcome 的区别；复用 handle、episode、request identity，补必要 run、owner-generation、effective execution mode、inputBase/candidate 身份。新 response schema 不让 `succeeded` 同时表示启动与完工。新增 `cancel` 操作；`continue` 明确是否 refresh inputs。

事件只承载有限的 owner / run / episode / phase / candidate / timing 事实，不携带 workflow requirements、不读取 Skill 或计划。Workflow 可以消费 shared type，不导入 executor 私有 store。

老记录明确标记 legacy：inspect/retain/discard/read-export 可用；不静默继续旧 private source、不重放历史 child。不要先开发通用数据迁移平台。

完成证据：结构解析、request replay identity、v2/v3 读取边界的窄测试；X-AC1、X-AC8、X-AC10 的合同部分。

## X02. Git-backed 任务工作区

初始区域：`workspace.ts`、`worker-inputs.ts`、`worker-tools.ts`、`graph.ts`、`repository-policy.ts` 与 workspace 记录结构。若需要新的 `git-workspace.ts`，它是本地薄封装，不建立通用 VCS framework。

实现临时 index capture 当前可见源码；以有效 parent index 的跟踪集合为起点，覆盖 staged 新增后又被 ignore 的 tracked 文件，随后更新成工作树内容。Tracked 的现状、unstaged/staged 最终文件内容、non-ignored untracked 与已删除文件均有明确语义；不能把 unresolved index conflict 自动当作解决。生成 Git checkpoint 与 owned ref，parent index/HEAD/stash/branch 不变。一次 create 复用一份 capture；不按 initial writeset 选择 dirty 文件。

创建 linked detached task worktree；环境准备复用仍必要的依赖/scratch逻辑，去掉 `.git` 必须是独立目录的假设。记录根路径与 namespace ref 的实际所有权。不为任务开普通 branch 除非具体需要；若开则纳入登记回收。

改 worker native file capability 为任务根内适用的写能力；initial inventory 不再 freeze 允许的具体文件。保持显式 forbidden paths、repo ownership 和真正的 path escape 检查。修改 graph overlap 判定：不同独立工作区内同名文件不是物理写冲突，真实共享资源锁仍有效。

检查 parent 输入中 plans / docs 可被 worker 读取；ignored 输入不默认复制，无效 baseline 必须透明失败。用户主仓 dirty 不是错误。

完成证据：disposable Git 覆盖 dirty/untracked/delete 输入、parent index 保留、两个任务隔离、scope 内新增 initial inventory 外文件、环境缺失的可解释错误。对普通 reset/rm 隔离只做适合当前变化的必要证明，不扩展为任意 shell sandbox 测试。

## X03. Session-scoped async supervisor

初始区域：`continuation.ts`、`scheduler.ts`、`managed-sessions.ts`、`runner.ts` 的必要接入。保留现有 child runner 和 native history，不引入第二套 provider/session 执行后端。

替换单一 active/completion batch gate 为一个 owner-scoped受管运行集合。create/continue 在登记和源码输入固定后返回；checkout、环境准备与启动继续在受管 queued/preparing 状态完成，不将其全量时长留在 parent tool 内。Child 执行由自身 AbortController 管理。跨调用共用 global/role capacity 与资源锁；同 handle mutation 串行。

每个 child terminal 立即保存并可 inspect，慢 sibling 不构成发布屏障。Foreground 模式只是在同一运行上 join；不能维护两份调度真相。Print/一次性环境不支持可靠 async re-entry 时明确 effective foreground 或拒绝显式 async，而不是返回一个失效承诺。

取消区分 queued/preparing、running、有限 freeze/apply 临界段与 terminal。现有 `/subagents` 可增加只影响本 owner 的 cancel 入口，复用同一 service，不让 readonly observer 另建控制状态。复用已有 process-group 清理，不为异步改成无主 detached daemon。重复 request 不重复启动，已返回 tool signal 不再代表 child 生命周期。

完成证据：controlled deferred Promise / fake child 证明 receipt 先返回；parent 可发第二次调用；跨调用限制不超额；task-local conflict 不阻塞无关任务；终态与取消顺序。不要用模型 token 或长 sleep 验证工具非阻塞。

## X04. Candidate、refresh 与 parent apply

初始区域：`candidates.ts`、X02 Git helper、相应 store 类型与 focused disposable Git tests。删除或收敛旧 FileState/manifest/digest 合并路径，不同时维护两套通用 diff representation。

Candidate 是 `inputBase` 与固定 worker result 之间的实际差异。Git OID 负责内容身份，保留 task/episode 归属；没有新增应用层 hash 链要求。

续接默认保留输入；显式 refresh 在 worker idle 边界三方组合旧输入、worker 工作与新 parent 输入。结果应用到 task workspace 之前保留旧版本，冲突交由原 worker/main 在授权 goal 内解决。不能在 child 运行期间将 parent 文件持续 cp 进去。

Parent apply 使用明确共同基线计算 M；只发布当前 P 到 M 的差异，index 不改。普通新增、删除、rename、mode、binary 差异使用 Git；冲突退出不修改 parent。Patch 不适用或实际 I/O 部分错误保留现场和状态，不自动 reset 全仓，不无限重试。

重点测试以下增量，不扩大成 Git 全功能合规项目：

| Case | Oracle |
| --- | --- |
| Worker 继承 parent dirty 但没改它。 | Candidate 不包含该 inherited change。 |
| Parent 后来修改/删除 baseline 中的 dirty 文件，worker 未改该文件。 | Apply 不把旧输入复活。 |
| Parent 与 worker 修改同文件不同区域。 | clean merge 保留双方，parent index 原样。 |
| 双方修改同位置或 rename/delete 冲突。 | parent 未被覆盖，保留所有版本供处理。 |
| 新文件不在 initial writeset。 | 允许候选进入 main 语义验收。 |
| Refresh 后再 repair、apply。 | 不重复包含 parent 输入或已经整合的 worker 变化。 |

完成证据：X-AC4–X-AC7。真正无法由普通 Git 处理的案例明确界定，不回到自建 file merge engine。

## X05. Notifications、context 与 host 生命周期

初始区域：`extensions/subagents/index.ts`、`continuation.ts` 的通知接入、`context.ts`、必要新 owner-local helper。修改 injected guidance，准确表达 async、单例/批次派发和正常等待，不继续注入 foreground-only 限制。

终态先保存，再发 typed event 和 compact `sendMessage`。保持同一 owner generation 的合并/去重，不声称 exactly-once 模型消费。无 workflow 时 executor 自己仍能通知；workflow 存在时同一事件只有一份 wake 请求。

核对 Pi 0.86.0 public message/session hooks；原 `message_end` aborted/error 分类可用于抑制唤醒，但不能把 compaction 或普通 agent_end 当目标取消。Session shutdown/reload/new/resume/fork 清理旧 live runs；tree navigation 处理 anchor 分支替换；compaction 保留可恢复的 current-owner index。

当 stop 原因无法由公开事件可靠区分时，保留结果并禁止自动唤醒，不猜测或用 private API补齐。真实目标取消通过显式 cancel 作用于运行。

完成证据：busy/idle completion、同时完成合并、duplicate event、abort/provider error、session replace、compaction。事件/owner 正确性是功能测试，不是额外的生产恢复演练。

## X06. Workflow 的异步 attempt 与等待状态

初始区域：`extensions/workflow/goal-host.ts`、`observation.ts`、`goal-store.ts`、`goal-state.ts`、`goal-tool.ts` 与 `settlement.ts` 的受影响部分；实际符号由源码定位，不预设所有文件都要修改。

将 launch tool boundary 关联到执行身份和当时的 attempt/basis。Terminal event 只能更新这个 association；不能把结果套到最新 current attempt，也不能在 completion 时重新 capture 输入来冒充执行前提。Inspect 可以补充缺失事实，但不要要求 parent 轮询。

Workflow 将“只剩运行中的 children”视为正常 wait；有独立 ready task 才 continuation。Completed result 到达后 executor 唤醒 main，workflow 更新事实和可推进性，不再发重复 follow-up。等待不等于 fulfilled，也不等于 no-progress suspension。

保留 main 对 verification / acceptance 的语义判定。Actual changedPaths 影响 proof freshness，但不制造新授权门。受信 transport control messages 不被识别为用户需求变更；child 文本不升级为系统权限。

完成证据：X-AC9 及与 X-AC8 的组合。用 fake executor events 测没有重复 loop、没有 launch-success=acceptance、没有 stale attempt binding；不搭第二个 scheduler。

## X07. Close、legacy 与可解释的回收

初始区域：managed store/continuation close、X02 workspace helper、必要 legacy reader。优先由 X02/X04 owner 续接。

实现 exact-owned worktree / namespace refs / scratch 的 retain/discard。正在写或还有未保全结果时不删除；明确 discard 可以回收 dirty managed worktree，但必须保持所承诺的诊断/结果 retention。无需为每个任务分支新建复杂引用计数平台；按现有 owner / handle 可确认引用范围完成最小回收。

旧 private workspace 可以 inspect、导出、retain/discard，但不自动迁移 live history 或执行未知请求。稳定文档写清升级时停旧 runs、新运行用新后端，保留旧成果的路径与边界。

Close 只针对 executor 所有资源，不能使用全仓 prefix prune/delete。未删除的资源有原因，不以“可能有用”无限默认保留。

完成证据：正常 close、明确 retain、legacy inspect/discard、dirty discard 的权限界限、shared baseline 仍有任务引用时不可提前删。无需破坏用户真实 Git 目录测试。

## X08. UI、telemetry 与持续会话投影

初始区域：`managed-observer.ts`、`observer-events.ts`、`render.ts`、`telemetry.ts`、`observation-hooks.ts`、`extensions/subagents-ui/` 和必要 evaluator 的 consumer。不修改 status-footer/work-timing 的无关表现。

UI 展示 session 多次提交的并行任务；不在 submit tool 返回时 finish 整个 observer。Terminal rows 与仍活跃 rows 可并存；旧 observer snapshot 有明确兼容行为。

Telemetry 分开 submit、queue、准备、执行、集成和后续任务完成。保留已有模型配置/推理与费用 provenance；inspect、replay、notification 不重复计量。Whole-goal accepted time 用现有 workflow 时点或明确 unavailable，不把 child durations 相加冒充人类墙钟。

完成证据：observer/evaluator结构和去重测试；不为本次作完整 UI redesign，不规定经济性 benchmark 达到某个数字。

## X09. 集成、回归与稳定文档

Main 合并上述 work，确保没有残留的默认 foreground busy、exact-path 必须完整、`.git` 必须独立目录、所有 dirty 都 refusal 等矛盾路径。不是仅改 README。

同步 `AGENTS.md`、`README.md`、`docs/architecture/subagents.md`、`subagent-execution.md`、`workflow.md`、必要 UI/evaluation 文档与实际接口。对原研究和历史 plans 只添加必要 supersession 引用，不批量改写历史。

先运行聚焦测试，再执行仓库规定的 offline checks：

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
bash scripts/run-temporary-workflow-probe.sh
bash scripts/run-installed-workflow-probe.sh
```

命令来自基线 AGENTS。Installed probe 若缺本地 Pi 路径或 PTY 前提，记录真实原因/skip，不自动安装到用户环境，也不将 skip 标作通过。Package checks 的失败先区分旧基线与本次改动，保持必要依赖安装在仓库/临时环境。[P2]

对异步+workflow+Git 的最终组合做一个受控端到端场景：dirty parent、两个独立 child、parent 可继续、一个先完成、按显式 join apply、另一个继续、review/repair 复用、close 资源。用 synthetic provider 或 fake runner，保证没有付费 provider 调用。

Review 重点限于输入/输出基线分离、late result 归属、取消/等待、用户修改保留。Main 对发现裁决，局部修复返回原 owner。没有新证据不重复全套验证，不用源码测试宣称实际模型 time-to-accepted 已改善。

## X10. 交付版本与完整 Git ZIP

交付主张必须区分源码、验证与运行安装：输出修改后的完整源码树、完整原始 Git 祖先历史与本地改动提交（在用户之后确认的范围内）、当前 branch / base / head、测试结果和未验证项。不得声称用户本机已经安装或运行。

两个 repo 各一 ZIP，包含 `.git` 与 tracked working tree，不含 node_modules、provider auth、用户配置、运行中的 managed sessions 或无关 caches。若修改是在 linked worktree 中完成，最终用正常独立 checkout/materialized repository 导出，不能仅打包一个指向沙箱绝对路径的 `.git` 文件。保留 symlink 与 executable bit 的归档元数据，说明合适的解压方式。

需要原始历史才能承诺“完整 Git 新版本”。GitHub Download ZIP 通常只是源树；通过网页拼出文件后 `git init` 不是原 repo 的新版本。输入是 standalone repo archive 或自包含完整 Git bundle 时，应先校验其祖先/refs，再基于指定 branch 实施。仅必要的最终 git status/diff、history完整性和归档检查足够，不建定制 hash恢复平台。

不直接写 GitHub、不 push、不创建远程 PR，不运行本地 snapshot publisher。用户自行取回并决定发布/安装。只有之后额外授权，才扩大交付端点。

## XP-04. 本会话能力核查结果

已实际确认当前容器有 Git 2.47.3、Node 22.16.0、npm 10.9.2、Python 3.13.5；未找到可直接调用的 `pi` 或 bun。工具链存在不代表仓库依赖就绪。

已尝试克隆两个公开 repo，均因 `Could not resolve host: github.com` 失败。普通归档下载和 raw 文件下载通路也未取得可用完整 repo。Web 阅读固定源码可用，因此四份文档能基于源码完成；容器尚未取得完整树/历史，未运行 npm/skills baseline checks。

也检查了当前可发现的插件能力，未获得可用于完整 Git 仓传入容器的现成入口。不能把“网页能读 GitHub”说成“现在能 clone、修改并验收两个完整仓库”。不通过伪造本地历史或只提供部分源码来冒充完整 ZIP。

因此，在线后续实施的可行性是条件性的：需要可用的完整源码/历史输入，以及依赖取得能力。可克隆环境恢复，或用户提供含 `.git` 的独立仓库归档/完整 bundle 后，可以在该环境中开始已批准实施；仍不预先保证 provider/macOS/用户真实 co-load 测试。当前应将本文交给本地 agent，或先满足上述输入再决定在线实施。

## XP-05. 批准摘要与真正暂停条件

当前只批准分析和文档；实现尚未开始。后续确认可一次覆盖两个 repo 的设计内修改、offline dependency setup/tests、disposable Git 操作、本地提交和两个完整 Git ZIP 交付。它不自动覆盖远程 mutation、真实付费调用、安装或生产副作用。

实施中直接处理：额外目标内文件、必要生成物、API 名称、单一模块的拆分、正常 debug/test/repair、同任务续接。不要将它们升级为重新设计或逐次用户审批。

只暂停受影响路径的情况：确实必须改变已定 goals/验收；需要新的生产/外部权限；仓库/历史或必需依赖不可访问；发现无法保留的用户数据冲突；宿主缺乏能表达所需契约的公开能力。技术问题能在既定范围解决就继续，不为“是否派发”额外调查。

本方案把 dirty 输入 capture 定为薄 Git checkpoint，而不是 initial writeset 子集或持续同步；确认本文后不再就每次 capture/ref/worktree 创建重复询问。若用户更愿意强制先 commit/stash，那是另一种明示输入策略，不应由实施者自行替换。

## 实施授权记录

2026-09-20：用户批准四份 design/plan，授权在两个仓库副本中实施、运行离线检查、创建本地 Git 提交并返回完整 ZIP。用户随后明确允许 best-effort 交付，受阻项如实记录；不包含远程 push、发布、安装或付费模型调用。

## 来源

- [P1 package.json / Pi 0.86.0](https://github.com/CsHeng/pi-extensions/blob/12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd/package.json)
- [P2 AGENTS / offline verification](https://github.com/CsHeng/pi-extensions/blob/12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd/AGENTS.md)
- 其余固定源码、Git 和 Pi 文档见 design；读取日期 2026-09-20。
