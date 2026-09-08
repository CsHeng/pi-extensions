# 完整 Worker、可续接 Child Session 与可归因遥测设计

日期：2026-09-07。状态：用户已确认完整 worker/续接目标，并明确排除 extension 自有 sandbox/container 设计、配置与安全验收；采用可信 host 执行与工作目录隔离。E1 已实施并验证，完整 worker 与受管续接仍待实现。本文为 stage artifact，不替代当前 `AGENTS.md` 或 `docs/architecture/` 的运行时事实。

来源：用户提供的根目录 `pi-extensions-design-r1.md`，本次按授权核实、改写并迁入 `docs/plans/changes/`。收到的 R1 文件 SHA-256 为 `c598acc94c95eb50f684f62e86eda8ceec2ee991932e60fd93df91bf27ead666`；原文记载的 `56ff0cfa…` 是其前序输入摘要，不是 R1 文件摘要。原第 18 节的多轮 worker/reviewer 复用要求已合并进主设计，不再依赖末尾冲突优先条款。

配套实施计划：[full-worker-continuation-and-telemetry-plan](2026-09-07-full-worker-continuation-and-telemetry-plan.md)。配套 `agent-skills-design-r1.md` 未在本仓库读取或修改；本方案不以它先行实施为条件，也不让运行时解析任何 Skill 或业务 plan。

## 1. 已确认目标与保留边界

Main agent 是 orchestrator，拥有目标、分解、权限判断、跨任务综合、review 裁决、repair/续接决定和最终验收。Worker 是任务与状态范围受限、但具有完整局部开发能力的 coding agent：自行调查、实现、编译、测试、诊断及范围内修复。验证执行可以委派，接受验证证据仍归 parent。

优先把有价值、内聚的工作交给 worker；多个独立就绪切片优先 flat batch，singleton 也可用于完整局部任务，不仅限于隔离或独立 review。Explorer 不是必经阶段，不增加派发配额、固定 explorer→worker→reviewer 流水线或“不委派理由”模板。琐碎工作、强耦合整合和不适配任务可由 main 保留。

同一任务必须支持 worker 返回后被打回续改、reviewer 返回后定向续审，以及 child 提问、parent 回答后继续。复用包括 native 会话与真实工作状态，不只是复用 task 名称或手工打开日志。Explorer 复用优先级较低，但不必在 schema 中禁止。

用户希望试验较强 main 与合适 workers 的组合，判断总费用、wall time 和介入成本；原文中的 Astra/Sol/Terra/Grok 是偏好背景，不是本计划的固定模型绑定或更改配置授权。同一 native session 不保证 provider cache 命中，重启 PID 也不证明 cache miss。

继续保留 Pi 原生 parent loop、foreground 调用、固定角色、普通 flat batch 及有真实前置产物且无中间 parent 决策的硬依赖。扩展不拥有业务审批、验收、自动 repair/重派、后台 missions、递归委派、动态角色、通用 agent 池或第二份业务任务数据库。必要的受管 child/workspace 注册信息属于本轮执行状态，不受“禁止持久化 orchestrator”排除。

`/plan`、Herdr 轮询、其他 extension 产品行为、任何 extension 自有 sandbox/container 管理及其安全验收、完整 benchmark/因果平台和自动路由优化不在本轮。OS 文件权限、凭据保护、网络与系统资源隔离归外部 sandbox/宿主；扩展既不提供这些保证，也不把其配置与验收作为功能前提。现有独立 extension 的回归仍须运行。

## 2. 本地核实与证据限制

本地 HEAD 为 `ba3207b5e7938a2f052961a2031310efd72588cf`，与原文公开基线相同。开始时唯一未提交项是用户提供的根设计文档。下表保留实施前基线的代码、类型与确定性检查证据，不是当前 E1 状态；后续修复与验证见配套计划第 10 节。

| 主题 | 核实结果与证据 |
| --- | --- |
| Pi 版本 | 当前 PATH 上 `pi --version` 为 0.85.1；`package.json`、lockfile 对应本地开发依赖为 0.84.4。CLI、开发类型和已加载实例不是同一版本证明。 |
| 已安装来源与有效配置 | 未读取用户 settings、route 文件或真实会话。后续 installed probe 只能证明可发现性，不能证明安装路径与本 checkout 字节相同；包内 cap 不能代替有效 cap。 |
| Worker 能力 | `extensions/subagents/roles.ts` 的 worker 仅 read/grep/find/ls/edit/write，禁止 shell；`runner.ts:78-83` 把 verification 写为 Expected parent evidence。 |
| Guard 与环境 | `child-capability-guard.ts:18-30` 的拒绝统一 `terminate: true`；`runner.ts:68-75` 近乎继承 parent env。快照不是 OS sandbox。 |
| Workspace | `workspace.ts:166-198` 复制 Git tracked/unignored 输入，不含依赖层或安全私有 Git 元数据；缺失新文件父目录处直接 `lstat`，常见缺目录实际抛 ENOENT，不能保证返回命名的 `new_file_parent_missing`。 |
| 导出 | `workspace.ts:211-266` 扫完整 diff，限制 exact create/modify、拒绝 mode/delete/symlink/未知变化，检查 parent baseline；逐文件 rename，不是多文件事务，也不防止外部并发写者。 |
| 参数 | `graph.ts` / `repository-policy.ts` 已做 trust、canonical scope、物理 containment、batch 整体拒绝；只读 `writePaths: []` 和 worker `externalReadRoots: []` 仍因字段存在被拒绝。 |
| 报告 | `protocol.ts:153-166` 保存每个 assistant message 的首个 text block；后续无 text 时会残留旧文本。`runner.ts:231-253` 没有完整最终报告的独立成功判定，exit=0 空流可以落入成功。 |
| 单次生命周期 | `runner.ts:119-140` 为 JSON print 子进程、stdin ignore、每次私有诊断路径；`index.ts:565` finally 删除 workspace。当前没有 handle、episode、续接或跨轮 baseline。 |
| 诊断 | `diagnostics.ts` 与 [现行架构](../../architecture/subagents.md) 明确 diagnostic JSONL 为只读证据，手工 `pi --session` 不恢复任务/快照；旧记录不能自动变成执行会话。 |
| 并发与预算 | 包内 global=10、explorer/reviewer/worker=4/4/2；`contracts.ts:8-33` task timeout=15 分钟、kill grace=5 秒、settled exit grace=10 秒，timeout 目前是代码常量而非用户 route 配置项。 |
| Guidance/compaction | `index.ts:658-664` 已在 active tool 存在时于 before_agent_start 注入有效 guidance。尚无同长任务自动压缩、最终 provider payload 可见性和逻辑 child 恢复的完整验收；不能称为“压缩必然删除工具”。 |
| 时间 | `index.ts:273` 记录 tool-entry，而成功路径 `scheduler.ts` 的 runDurationMs 从 scheduler 开始算；早期失败从 tool-entry 算。`render.ts:89-90` 以最大 child elapsed 表示 progress elapsed，不能表示错峰/串行整批 wall。 |
| 遥测/evaluator | runtime schema=3，包含 requested/admitted/launched、阶段时长、有效 cap、opaque provenance 与 route。evaluator 输出 schema=3，消费 runtime 1/2/3；按 task usage 求和，尚无 parent+child 全链路或跨 episode 去重。 |
| Work timing | `extensions/work-timing/index.ts` 已用 performance.now，entry version=1，仅 TUI request wall 与客户端 thinking 区间；无 agent_active_time，也不包含 child reasoning。 |
| 可用执行机制 | 本次发现 Docker CLI 且只读 daemon 查询可达；未发现 bwrap/podman 可执行文件。未启动容器、列举工作负载、拉取镜像、修改 daemon 或证明 runtime 隔离。 |

本次初次 `npm run check`：类型检查通过，测试 237/238；唯一失败是根设计含 `agent-skills`，被 `tests/repository-boundary.test.ts` 当作 maintained text 扫描。将其移入已有排除的 `docs/plans/` 后，该边界测试 4/4 通过。不是删断言或降低安全要求。完整复验记录归配套计划。

未读取真实拒绝分布、用户费用/订阅 quota、实际主会话 payload 或有效配置。没有这些日志不阻止可重复的机械修复，但不得宣称已解释低派发率、模型收益或 compaction 因果。

## 3. Pi 接入选择与兼容性

现场已完整阅读 Pi 0.85.1 的 README、extensions、JSON、session-format、compaction、environment-variables 文档，并核对本地 0.84.4 的相关导出类型。`registerTool` 同名覆盖、各工具 operations、`tool_call` 的 block/terminate、agent_settled、context/session/compaction hooks 均有公开接入面。工具适配必须保留准确 result/details 和显式 prompt metadata；cwd/env 只提供工作上下文，不宣称 OS 安全隔离。

0.85.1 JSON message_update 是 delta-only，message_end 才是最终消息；新 session compaction 支持 retainedTail，旧格式保留 firstKeptEntryId。不可按旧全量 partial 或自行重写 JSONL 的假设实现。`terminate` 在并行工具批次中只有所有最终结果都 terminating 才停止 agent；致命任务状态失效还必须由 runner 停止本任务受管执行，不只返回该标记；这不是拦截任意宿主访问的安全边界。

选择每个 episode 启动独立 Pi JSON print 进程、打开同一受管 native session。它最接近现有 runner，足以满足“返回后再发送”，无需常驻 RPC、后台 polling 或新的 SDK 故障域。每轮重新校验权限、branch leaf、route 与 workspace，再追加一个新输入；不重写历史、不复用上一轮 parser 状态。

运行中 steering、常驻 RPC 优化留后续；foreground 工具等待期间 main 没有自动控制回合，不能因换成 RPC 就宣称全双工。若将来确需它，升级触发条件是可观测的启动成本或真实运行中交互需求，而非缓存猜测。

第一版在公开 0.84.4 API 上保持编译兼容，同时用已装 0.85.1 做 native 接入验证。新增必需 API 若不在两者共同能力内，停止并提出显式版本支持调整，不悄悄升级 peer/dev 依赖或运行时。

## 4. 完整 Worker 执行边界

完整 worker 使用可信 host 执行：独立工作目录承载源码、依赖与 scratch，Pi 文件/搜索/bash 工具操作同一任务状态，child 不加载 Skills 或递归委派工具。它是有局部开发能力的普通 coding agent，不是扩展自行建设的受限 OS 主体。

独立目录、精简环境、文件工具 guard 与候选检查分别减少工作互扰、上下文噪声和错误导出；它们不能阻止 bash 使用绝对路径、读取宿主文件或启动其他进程。Exact write set 约束任务协作与 parent apply，不能宣传为任意命令的系统权限上限。需要这种安全保证时，由外部 sandbox/宿主提供，扩展不设计、不配置、不验证其隔离效果。

不新增 Docker 后端、镜像/网络/CPU/RAM/PID 配置、sandbox conformance 或 `csheng-subagent-execution.json`。旧计划 C1 撤销，不再用环境审批阻塞功能；原容器方案只作为已撤销选择留历史。执行与模型路由保持分离，executionProfile 不变成权限开关。旧 one-shot 仍保持 edit-only，新受管 worker 路径明确提供完整工具，不能把缺少必需工具的运行冒称完整能力。

环境准备复用已有 Pi/项目工具链，精简无关上下文并不额外复制认证文件。依赖来源与 lockfile/输入身份可核查，优先私有副本或已存在的非共享可写依赖；不能让不同任务写同一份依赖目录或 parent `.git`。不默认每 worker 在线重装、全局安装、提权或修改宿主配置。实际项目缺少必要依赖时报告具体缺口，不制造通用镜像审批流程；下载和外部操作仍受已有用户权限约束。

所有 standard tools 使用同一 cwd/source/scratch；完整 worker 要求显式 repo-wide 输入 `scope: ["."]`，不能将窄 scope 悄悄扩成全仓库。既有只读角色 externalReadRoots 的工具检查与 worker 不声明外仓库写入的契约保留，但不把它们误称为 bash 的 OS 访问控制。

同 worker 的受管工具操作以 workspace queue 串行化，覆盖 bash 与 edit/write，不靠 shell 字符串分类器猜测读写；不同 worker 独立并行。记录命令退出、超时、取消与已知进程/测试服务清理结果；冻结前停止本实例管理的写者。无法确认受管命令已结束时不导出。对脱离受管生命周期的任意宿主进程不作无逃逸保证，也不借此扩建 sandbox。

## 5. 输入、scratch、候选与导出

保留 exact write set，不开发动态目录租约。读取足够调用方/接口/测试依据不等于拥有其源码。需要扩大精确写集合时回 parent 协调；已批准目标内的普通切片调整不必重审整个设计，但 child 不能自行扩权。

Scratch 默认位于源码之外。确须源码内产物时按已声明的项目产物规则识别有限目录；不能忽略所有 gitignored 或未声明改动。最终候选必须区分允许源码、允许产物、未知变更。未知源码、unsupported delete/rename/mode/symlink 操作阻止 apply，不能白名单摘取后仍声称测试对应导出结果。

支持已声明新文件的缺失内部父目录：逐组件验证真实 containment/type，安全创建，导出前重验，symlink/文件冲突失败。只清理本次创建且仍为空的临时目录，不删用户新内容。

冻结后的候选携带内容/输入/环境身份及验证引用；child 命令事实不等于业务通过。临时改源码诊断后恢复，要对恢复后的候选重验；继续编辑、依赖同步或环境重建均使相应旧证据失效。

保留扩展内部 convergence 临界区与 parent baseline 检查，保护无关用户修改。逐文件 rename 只能保证单文件替换；中途失败必须记录已应用路径、未应用路径及 uncertain 状态，不能报告整项 applied 或自动回滚覆盖新的 parent 工作。外部进程仍不受扩展内部锁约束。

## 6. 受管 session、episode 与操作契约

逻辑 session 关联同任务、role、对话与工作状态；episode 是一次初始/后续输入至正常交回/失败的执行区间；OS 进程是可替换载体。一个 episode 内可以多次模型 turn 与局部 repair，不设默认固定 repair 次数；真实时间/资源/取消预算仍有界，无新诊断且无可行路径时具体报告阻塞。

保留原 `csheng_subagents({tasks})` 的 one-shot 语义与清理规则；新设窄工具 `csheng_subagent_sessions`，暴露 create、continue、inspect、apply、close，避免新字段无声改变旧 tasks。创建/续接可批量，各 session 一次一个 episode；inspect 可列当前 owner 的有限 session 或取单个最新结果。最小版本同时覆盖 worker 与 reviewer。

新路径默认交回候选，不自动 apply；parent 明确选择候选身份执行 apply。这样完整的问题/blocked/no-change 报告都是可处理的 episode 结果，而不是自动导出或业务通过。旧 one-shot 仍可机械 auto-converge，但必须满足新最终报告完整性；旧 worker_no_changes 不改义，新路径允许正常 no-change、convergence=not-applicable。Apply 只是机械导出，不代表 parent accepted。

Handle 为 opaque 不可猜测标识，不接受任意 JSONL/目录路径。注册信息最小包含 schema version、canonical repository/parent owner、创建所在 parent branch 关联、固定 role、native session 与当前 leaf、能力/route revision、workspace、episode/request 关联、最近候选、已导出 baseline 和状态。它不存业务 graph/审批/自动 repair policy。Native 历史及格式迁移继续由 Pi 拥有。

同 handle 需要跨进程单写者锁；旧 parent fork/clone/树上不可达分支或其他项目不能继承写权。相同 owner 重启可核对并恢复 idle，不自动执行；旧 running、未知进程归属或 ack 丢失标 interrupted/unknown，不能仅凭 PID 判定锁可抢占。

Continue 必须带唯一 requestId 与上一 episode 版本：已完成的重复输入返回已有结果而非重跑；相同 ID 不同内容拒绝；并发、过期版本拒绝；已提交但副作用完成情况不明保持 unknown。保证是可定位与防误执行，不是任意命令 exactly-once。

Idle 无进程/推理/工具写入，释放 active role/global slots；保留 native history、workspace 和有用依赖身份。首次配额沿用每 parent 十个逻辑 session 的有界量级，managed store 初始 512 MiB 上限仅作为保守 admission ceiling，独立于 active cap；超额拒绝新建，不自动删除 idle 或未处理候选。大 workspace 的可用性用 disposable 本地项目 fixture 测量，扩大额度需显式配置，不用这些数字宣称适合所有项目；该上限是扩展自有数据 admission 政策，不是宿主或命令磁盘 quota。

Close 幂等：无未处理候选可正常关闭并按诊断策略留历史；有未导出或未裁决候选时默认 retain，只有 parent 显式且有权放弃该工作才 discard。先写可核查 closed/retained 状态再清理本对象资源，禁止套用 settled diagnostics 的旧 GC 删除可续接 workspace。Shutdown 停进程、留恢复事实，不把它当成完成或丢弃授权。

## 7. 多轮一致性与 reviewer 复用

令首次 baseline 为 B0，worker 返回 C1。若 C1 未 apply，继续修到 C2 仍对 B0 计算完整候选差异；若 C1 已 apply，记录 E1 作为下一轮已导出 baseline，C2 仅导出 E1→C2，并再次检查 parent 匹配 E1。重复 apply 同候选不写入；部分 apply 不推进整轮 baseline，进入需核对状态。

Continue 前同步 parent 改动的非任务输入，更新依赖身份并使受影响证据失效；不能整树覆盖未导出修改。Owned 文件漂移由 parent 协调，不能自动合并覆盖。同步失败保留本地候选与旧基线，如实阻塞。

Reviewer 有独立 native session 与只读当前输入/revision。定向复审保留旧 findings 背景，但实际读取新候选；不能在 worker 历史上换 role prompt 冒充独立 review。Parent 可因锚定/错误假设选择 fresh reviewer；扩展不自动安排复审或裁决 findings。

恢复旧 diagnosticSessionRef 不等于创建受管 session；缺 workspace/capability/baseline 的旧日志只读可查。导入/重建不在首版，不能默认为具有连续执行与收敛保证。

## 8. 完整报告与可恢复失败

每 episode 新建 parser，使用本轮最终 assistant message 的全部 text blocks；普通 prose 不要求固定 done/pass 词。有效最终报告要求正常终止 stop、非空最终文本、完整工具配对、无待完成调用，并观察 settlement/正常进程关闭；length/pending/toolUse/error/aborted、空流、只有 tool result、残留旧文本、截断协议或最后一轮缺报告不进入自动导出。展示截断不等于协议未完成。

Agent_end 不等于 settled，settled 不等于进程退出，退出不等于候选冻结，apply 不等于业务接受。早期测试/工具错误保留累计诊断但不永久污染后续完整结果。合法“未发现问题”及正常提问不是空报告。模型声明 completed/blocked 也只能是声明，不从 prose 推导 acceptance。

| 失败类型 | 行为 |
| --- | --- |
| 未选择工具 | 不是 rejection；缺少适用样本不能算漏派。 |
| 参数/graph/admission | 整批预检；定位 task/field/code；未启动可由 parent 在原授权内修正重发，不静默丢无效任务。 |
| 安全拒绝 | 已确认操作未执行、能力仍有效时返回非 terminating 工具错误，让 child 在原权限内纠正。 |
| Manifest/工作目录/身份失效 | 停止受影响 episode 的受管执行，保留证据，不依赖单个 terminate hint，不换目录或绕过候选检查。 |
| 编译/测试失败 | 留给 worker 局部诊断和修复，不自动 parent takeover。 |
| 环境/provider/timeout/取消 | 分阶段保留实际 launch、usage 与部分效果；不隐式换模型、扩路径或重试。Pi 原生 retry 另行计真实消耗。 |
| 报告不完整/未知变更/drift | 保留证据，不正常 apply；parent 决定修复/核对/新任务。 |
| 取消撞上 convergence 临界区 | 沿用 task too-late/run 等临界区完成语义；中断和部分失败不伪报完整导出。 |

空 optional array 只在不增加权限时规范化为缺省，非空越权不放行。已部分执行的命令失败不等于安全零副作用拒绝。后续派发必须保留此前已执行切片及消耗，不重复运行已完成或仍在运行的工作。

## 9. Compaction 三类连续性

能力由当前 active tools/schema 与真实工具执行证明；策略由最终有效 guidance 证明；委派状态由 native parent tool results、当前受管 registry 与 parent-owned 目标材料共同恢复。三者不能互相代替。

复用 before_agent_start 的短小幂等指导；同长任务自动压缩继续若需 context 投影，只投影当前 owner 的有限 handle/episode/candidate 事实，不复制全部历史或生成新业务摘要。测试应观察后续 handler 之后的实际 request，而非某个早期 hook 输入。禁用 guidance/工具或能力不可用时不得重新启用。

覆盖手动压缩、自动 threshold/overflow 后同 run 继续、压缩后新请求，以及 child 长回路、parent resume/fork/tree/reload。恢复后先 inspect，不自动重派、重放命令或重复 apply；旧摘要 running 不是当前运行证据。只记录工具可见性、guidance revision/来源和 opaque 关联，不长期保存 system prompt/provider payload。

## 10. 最小遥测及口径

复用现有 producer/provenance/evaluator，runtime 与 evaluator 各自升级到新 schema，旧版本含义保留。最小对象为 request、dispatch、逻辑 session、episode、模型/工具/command span；只有真实 change 开始和 parent acceptance/交付端点同时存在才报告 delivery wall。无 disposition 时 accepted/repair/takeover 均 unknown，不从下一条 prose 或 parent 改文件推断。

Batch elapsed 统一从可观测 tool-entry 到结果就绪，另列 scheduler interval；pre-execute schema 拒绝若由 host 事件可观测则记录，否则明确覆盖缺口。Queue 分 dependency/ready/capacity/role/lock 与 environment preparation；重叠原因保留区间或注明分类规则，不称 provider queue。

进程内 duration 用单调时钟，跨进程 child 区间用 parent 共同观察基准，wall timestamps 仅关联。不可相减不同进程 performance.now。缺端点、时钟异常、取消或未闭合 span 标 unknown/partial，不补零或 clamp 成正常数据。

```text
worker_effort_time = sum(worker episode execution intervals)
worker_occupied_wall = length(union(worker episode execution intervals))
average_live_workers_over_batch = worker_effort_time / batch_wall
parent_non_delegated_elapsed = request_wall - length(union(request 内 subagent wait spans))
C_total = C_parent + sum(C_child_episode_delta) + 其余未重复计入的真实模型调用费用
```

三条重叠十分钟 child 区间的 effort 是三十分钟、occupied wall 是十分钟，batch 还含准备/整合。进程存活并发不是计算利用率；parent non-delegated elapsed 也不是纯计算时间。Parent ΣR/request wall 下降可能是有效 offload，所有 agents 的 reasoning sum/request wall 可超过 100%。

最小采集包含入口 requested/admitted/launched、typed failure、有效 caps、child 共同时间区间、command 数量/时长/退出状态、guard recovery、最终报告完整性、候选/apply 状态、workspace/dependency cold/warm/rebuild、create/continue/fresh review/close、active/idle、compaction 连续性和 resolved route/thinking/provenance。

每个 native assistant/summary/nested-tool usage 由稳定消息/调用身份拥有，episode 只计算新输入之后新增调用。历史重复读取、retainedTail 引用、结果重取、父 tool usage 汇总与 child JSONL 不能重复计费。缺少可靠身份/费用来源则 partial/unknown；明确 SDK/catalog 估值、实际账单与订阅 quota 的来源和覆盖，不将零缺省解释为免费，也不将 API 美元冒充 Pro 扣额。

Headless-compatible 小型 collector 归 subagents 观测面，不要求 child 加载 work-timing UI。`work-timing` 保留独立 TUI-only request/observed reasoning 语义，UI 只是事实消费者，不成为 batch 时钟或调度 owner。性能采集失败可降级为 unavailable，但必需执行证据、工作目录完整性与现有诊断容量失败仍 fail closed。

聚合输出不含原始 prompt/objective/argv/stdout/stderr/task ID/repo 路径/环境值/凭据/route 文件；必要关联使用 opaque IDs。私有 native 历史维持访问/容量/retention 边界，不复制原文到指标。Parent disposition 首版可使用有范围的人工标注，不强制每轮额外模型调用。

## 11. 验收与演进

必需机械场景：同状态 edit→test→repair、范围内批量/间接写入、scratch 分类、未知源码拒绝、缺目录创建及 symlink 反例、同 child 并行 tools、受管命令及普通子进程取消、候选冻结、parent drift/部分 apply、空值规范化、一次安全拒绝后继续、能力损坏终止、exit=0 无报告拒绝、多 text blocks/早期错误恢复。

必需多轮场景：worker C1→parent 打回→C2；reviewer 读新 revision 续审；question→answer；idle 释放 slots；进程重启保留同任务；C1 已/未 apply 两条 baseline 路径；重复输入/并发/ack 丢失/fork；本轮无报告不能用上一轮文本；parent compaction/restart 后 inspect；usage 增量去重；close/GC 不丢未处理工作。

必需时间/兼容场景：并行/错峰/串行/role cap/锁的合成轨迹、旧 schema unavailable、跨 episode 重读不重复累计、缺 endpoints/费用/disposition、TUI/headless 开关与性能 collector 失败。同状态工具与普通进程清理必须使用 disposable 本地 fixture 运行真实命令验证，不能只依靠 fake-Pi。宿主路径/凭据/socket/网络逃逸及 sandbox 安全验收不在本扩展范围，不读取真实凭据作测试。

Provider 行为观察是独立授权 lane：至少一个必须多轮反馈的内聚 worker 与另一独立切片并行，覆盖 parent 打回续改、reviewer 续审、可恢复拒绝及 compaction 后有效派发。固定注入 tool call 只能证明机制，不能证明模型主动选择、费用节省或收益。没有统一样本量、固定降本承诺或强制模型矩阵。

本轮最小交付必须同时具有完整局部 worker 与 worker/reviewer 轮次间复用；可以分可审查增量实施，但不能把复用或必要遥测改称长期研究。后续只在可观测瓶颈出现时考虑常驻 RPC、并发 2→4 试验或更完整 benchmark；外部 sandbox 不作为 extension 后端路线图；持久 route/cap 修改、安装、付费调用、发布部署仍需其明确权限。
