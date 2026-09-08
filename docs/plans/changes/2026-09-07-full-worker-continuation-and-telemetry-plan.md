# 完整 Worker、可续接 Child Session 与可归因遥测实施计划

日期：2026-09-07。基线：`ba3207b5e7938a2f052961a2031310efd72588cf`。设计：[现场核实后的 R1](2026-09-07-full-worker-continuation-and-telemetry-design.md)。

状态：E1（T00–T03）已完成并验证。用户已明确排除 extension 自有 sandbox/container 设计、配置与安全验收，撤销 C1；本计划按可信 host worker 与工作目录隔离修订，不再等待镜像、配额或容器许可。E2/E3 仍需实现，不能把范围修订或 E1 验收冒称完整 worker/续接已交付。原计划 review 见第 9 节，E1 历史证据见第 10 节，当前收尾结论见第 11 节。

## 1. 目标、范围与非目标

交付一个有界版本：worker 在同一受管状态正常使用文件工具/bash 并完成局部反馈；parent 可让同一 worker 续改、同一 reviewer 续审；每轮结果完整性、候选/导出、恢复状态及增量费用/时间可核查。Parent 保留所有语义裁决与最终验收，Pi 保留原生 loop/session。

仓库 owner 仅为当前 `pi-extensions`。本次计划不修改 sibling Skill 仓库、用户 routes、settings、credentials、trust、真实 session 或 provider 设置。新模块使用现有 TypeScript/Node 与 Pi public API，不新建独立服务或 sandbox 管理层，不需要另选实现语言。宿主权限、凭据保护、网络和系统资源隔离属于外部 sandbox/宿主，不由本扩展设计、配置或验收。

非目标：Docker/镜像/daemon 管理、sandbox 安全策略或 conformance、运行中双向 steering、常驻 RPC 池、自动 review/repair/accept、后台 missions、递归/动态角色、全局 workspace 锁、多文件事务承诺、动态写集合、旧 diagnostics 自动导入、通用 benchmark、价格/quota 推导、默认改 cap 或模型组合、Herdr 与 `/plan` 产品改造。

## 2. 确认项、权限与执行窗口

| ID | 状态 / 必需事实 | 影响 |
| --- | --- | --- |
| C0 | 已确认：完整局部 worker、积极内聚委派、轮次间 worker/reviewer 复用、parent 裁决、最小遥测；本地 HEAD 与原公开基线相同。 | 不重新问完整需求，不以旧 no-shell/no-continuation 边界否决新目标。 |
| C1 | `withdrawn`：用户明确将 sandbox/container 设计与安全验收排除出 extension 职责。 | 不再要求 environment record、镜像、容器资源配额或操作审批；不据此前批准启动容器。T04 改为可信 host 工具与工作目录接入，独立目录不宣称安全沙箱。 |
| C2 | 用户已批准实施与继续，并明确收窄为无 extension 自有 sandbox 的职责范围；本次要求验收收尾。代码、测试和 truth-sync 触及面见第 5 节。 | E1 可独立验收；其余已授权的功能不因已撤销 C1 阻塞，也不因收尾请求自动算完成。无需再次请求容器或普通实现选择批准；C3 不在已有授权内。 |
| C3 | 真实 provider 行为实验、安装/全局配置变更及 route/cap 试验均未获本计划授权。 | 不阻止确定性代码验收；阻止“模型行为/经济性已验证”与实机启用完成声明。现有凭据存在不等于授权。 |
| C4 | CLI=0.85.1，开发依赖=0.84.4。T00 已用无网络合成 provider 验证两版本原生 delta JSON/append/settlement，并将实际 stdout 接入最终报告 parser。 | 依赖未升级；受管多轮与完整 host worker 的接入验证仍属后续阶段，不能从本 fixture 推断已实现。 |

不再交付 C1 environment record 或 `csheng-subagent-execution.json`。工具链/依赖/源码产物身份只作为任务状态和验证可归因输入，不变成 OS 安全策略。已有依赖可复用；若某个项目确需下载、外部服务或全局操作，只处理该项目的具体权限缺口，不重建通用环境审批流程。

E1：T00→T01→T02→T03，机械完整性、无权限空值、安全拒绝、新文件目录与独立计时基础；之后停在 parent 综合验证点。E1 不承诺 shell 或复用已完成，不改旧成功/no-change 含义。

E2：T04→T05→T06→T07→T08→T09，可信 host 工具接入与受管多轮工作流；无 Docker 前提。T07 先交付保留 workspace 的 edit-only 受管验证切片以定位状态错误，T08 再接完整 worker；这个内部增量不是最终产品或隐式 fallback。

E3：T10→T11→T12，collector/evaluator/UI、全量验证与真值同步。T13 是另行授权的真实观察，不用其缺失阻止无 provider 的机械验收，也不能将其缺失说成收益已证明。

X1：任一阶段发现任务状态或数据保护保证不可实现，停止对应边界，返回 `needs_design_decision`，不冒称已满足。X2：具体任务的权限/依赖/服务前提缺失只阻塞该步骤，可继续无依赖任务；不增加已排除的 sandbox 前提。X3：parent/source/registry 漂移或部分 apply，fix-forward 核对现有状态，不自动 reset/clean/回滚。

## 3. 本地适配决定与冻结接口

### 3.1 可信 host 工具与工作目录

完整 worker 使用 Pi 原生文件/搜索/bash 工具与独立任务目录，源码、scratch、依赖和工具 cwd 一致；child 不加载 Skills 或递归委派工具。精简环境与目录分离是工作上下文机制，不是宿主文件、凭据、网络或进程的安全隔离。Bash 与普通可信 coding agent 一样运行在宿主权限下；需要 sandbox 的环境由外部负责。

保留工具 promptMetadata/result/details 与 Pi public API 兼容；同任务工具操作经 workspace queue，释放在真实 operation finally，不只锁 tool_call preflight。辅助输出/临时文件使用任务目录，记录所属资源以便清理。跨 child 不共享可变源码、依赖或 cache，不修改 parent `.git`，不默认联网重装或全局配置环境。

不新增 execution capability 配置、Docker 管理或后端选择；executionProfile 仍只表示路由意图。新受管 worker 路径提供完整工具；旧 one-shot edit-only 契约不改。工具/工作目录故障如实报告，不把不完整运行宣称为完整能力。

完整模式要求显式 repo-wide 输入 `scope: ["."]`，exact writePaths 继续约束声明工作与候选 apply；这些不是 bash 的 OS 访问控制。Legacy 窄读取与只读角色工具检查保留，不自动扩 scope。正常受管命令/子进程退出与取消由扩展管理，任意逃逸进程的 containment 不在验收中；未确认本实例受管写者已结束时不得冻结或 apply。

### 3.2 兼容工具与多轮结果

旧 `csheng_subagents({tasks})` 保持原 schema、one-shot workspace cleanup、机械 auto-convergence 与 worker_no_changes；但修复不完整报告不得成功。新 `csheng_subagent_sessions` 使用 direct string enum action，加 action-specific 严格验证，不复用 executionProfile 表示权限。

| Action | 必需输入与结果语义 |
| --- | --- |
| create | batch `requestId` 与 `tasks`（现有 bounded task shape，1..10）；创建 opaque handle，启动首 episode，返回状态/报告/candidate，不自动 apply。重复 create 的 tool 调用关联须可核对，不能因 ack 丢失重新创建同任务。 |
| continue | `episodes` 1..10；每项 handle、requestId、expectedEpisode、bounded message；保持 fixed role/exact write set，重新核对 current trust/capability/route。结果是本轮增量，不重放全部历史。 |
| inspect | 可省 handle 列出当前 owner 最多十个对象；指定 handle 只读获取有限 latest episode/result/candidate/capability 状态，不触发模型或 session migration。 |
| apply | handle、expectedEpisode、candidateId；仅对完整、冻结且安全的 worker candidate 做 CAS 导出，结果 not-applied/applied/partial/conflict/unknown 分离，重复同 candidate 不重复写。 |
| close | handle、expectedEpisode、`disposition: retain|discard`；默认 retain，不丢未处理候选。Discard 需要 parent 具有该工作放弃权限；旧 session 不能靠关闭重开扩权。 |

新增输入字段在 `session-contracts.ts` 固定 UTF-8/数量上界（沿用 objective/input/prompt 限额；handle/requestId 使用有限长度安全 opaque grammar），拒绝未知键、路径替代 handle、重复 handle 与不可能动作组合。每个 action 都返回稳定 field/code；无权限 empty optional arrays 可规范化，非空越权不变。

Logical state：idle、running、interrupted/unknown、closed。Episode reportComplete、candidate/freeze、apply 与 parent semantic acceptance 分字段；不从文本识别 blocked/done。正常 question/blocked prose 可交 parent，机械完整并不证明任务通过。Managed no-change 是正常报告、无 candidate；legacy 仍是 worker_no_changes。

Create、continue、apply、close 的关联由 extension 保存最小 request 操作记录，不存业务 graph。相同 requestId/内容与版本已完成时只返结果；相同 ID 不同内容拒绝；in-flight/未知不得重放。Native session leaf、parent branch、repo identity 和 workspace fingerprint 都是验证输入，不把摘要/handle 当独立权限凭证。

### 3.3 持久状态与多轮 baseline

新 `managed-sessions.ts` 拥有独立 private managed root，native history 由 Pi 写，registry/lock/candidate 文件由扩展写，0700/0600、exclusive create、schema version。与旧 diagnostics 存储/GC 物理分离，旧日志只读检查不升级。

一个 parent/repo 最多十个逻辑 session，managed root 初始 512 MiB admission 上限与 active concurrency 分离；以本地 fixture 核对项目 footprint 并可显式配置额度；这是扩展存储 admission 限制，不是命令磁盘 quota。所有 open/idle/interrupted/未处理候选都计入占用且不自动淘汰；超额拒绝新增或冻结受影响执行，保留已有数据。不引入 idle TTL 和 LLM 保活。Closed 且已安全处置的历史可按现有 30 天诊断量级回收，但未处理候选不可因年龄删除。

跨进程锁覆盖同 handle 的 history/workspace/registry mutation；owner 为 canonical repo+parent native session+branch 可达性。Fork/clone/跨项目拒绝续接旧写权；重启同 owner 先 inspect。Lock 失主无法证明、session leaf 不匹配、已执行命令无结果，均保留 unknown，不自动 reclaim/replay。Parent shutdown 停所有本实例写者、记录 interrupted/idle，可继续对象不删除。

候选算法以 B0/C1/E1/C2 场景固定：未 apply 的 C1/C2 始终对 B0；已 apply C1 才把全部成功导出身份推进 E1；后续 parent owned-path drift 失败，非任务输入按差异同步并标旧证据失效，不覆盖未导出 owned bytes。多文件中途 rename 故障记录精确 prefix，整轮 baseline 不推进；恢复读取 parent 与候选逐路径核对，由 parent 决定下一步。

### 3.4 遥测所有权

Runtime telemetry v4 与 evaluator output v4 显式区分旧 v1/v2/v3：原 runDurationMs 不在旧版本上重解释，新版标记 tool-entry elapsed 与独立 scheduler interval。Parent 共同观察 child start/end，duration 用单调 clock；墙钟只做跨请求关联。队列原因重叠保留，不凑成 100%。

Headless collector 放在 subagents 观测面，仅该 extension 启用时订阅 parent/model/local-tool/wait/compaction 事件；child command/span 来自 runner/worker-tools，避免为采集加载 TUI 扩展。Collector 自身不开模型调用、不改变 active tools/guidance 或调度。

Usage owner：native assistant entry、compaction/branch summary entry 或 nested-tool call 各计一次。Episode 游标+native entry/call identity 只计新增 usage；parent tool-result 的 child aggregate 只是引用同一份 usage，不能再加 child JSONL；retainedTail 是上下文副本，不是新计费事件。重复 inspect/apply/continue-result 不累加。无法证明覆盖时 partial/unknown，不把缺省 0 当免费。

Work-timing entry v1 保留旧语义/读取兼容，TUI 只说明 parent observed reasoning 与 request wall；新 collector 不写它的 entry。UI 移除不影响事实或执行保证。Accepted delivery wall、semantic repair/takeover 首版仅接受有范围的 parent 人工 disposition/接受端点；缺少时 unavailable，禁止 prose 推断。

## 4. Oracle 与验证通道

边界 owner 是本仓库；parent 实施者执行验证、判断证据并接受修复。安全负例、schema 含义或状态机断言的删减/放宽必须独立审查，不能为绿灯修改验收。使用示例/契约/小型状态机+故障注入，不建设通用 model-checker 或全套 benchmark。

| Lane | 边界 → oracle → fixture → suite → 失败含义 |
| --- | --- |
| V1 fast | 参数/报告/时钟/usage → exact examples 与 schema contract → fake streams、可注入 clock、合成 native entries → 对应 `tests/subagents-*.test.ts` → 阻断关联任务。 |
| V2 merge-local | snapshot/单写者/多轮导出 → 状态转换与 failure prefix → disposable Git、temp private store、独立 Node 进程/故障注入 → workspace/managed-session/continuation suites → 阻断安全与多轮交付。 |
| V3 merge-host-tools | 同状态 tools、命令结果与普通子进程生命周期 → edit/test/repair/cancel 场景 → disposable 任务目录与真实本地命令、无网络/凭据 fixture → `tests/subagents-worker-tools.test.ts` → 未通过不得宣称完整 worker 可用；不证明 OS sandbox。 |
| V4 host/package | 原生重开、compaction、最终 payload 和加载/移除 → real Pi interface conformance → 临时 agent home、无凭据 local fake provider、固定 native session → host/continuation integration 与既有 probes → 分清 CLI/dev 兼容或安装实例偏差。 |
| V5 authorized-observation | 主动分工、局部闭环/续审、费用/经过时间 → 人工稳定任务验收 → 明确授权真实模型+disposable repo → 单独 live E2E/evaluation → 只对实际组合/样本声明观察，不代替安全验证。 |

V1/V2/V3 fixture 使用临时 home/cache/ports 和显式最小 env，不访问真实凭据或服务；只有既有明确测试 ambient behavior 的 lane 可继承并脱敏。V3 在 disposable 本地目录运行真实脚本/解释器，验证相同源码状态、退出/取消、产物分类和已知子进程清理。移除路径/凭据/socket/网络逃逸 canary 与容器 gate；fixture 的无网络条件不意味着 runtime 提供网络隔离。

各任务先增加会因目标缺口而失败的 oracle，再实现；保留红灯原因、修复后窄测试命令/退出状态及真实边界。不用关键字快照测试 guidance prose；使用 active tools、实际 payload、调用行为与人工 review。原有仓库边界静态测试不为迁文档放宽。

## 5. 稳定任务与写入范围

下列路径均相对本仓库。标“新增”的模块名是本计划选定落点，非现有事实。每项先做窄 oracle，完成后 parent 汇总证据；表中的依赖是前置产物/共享资源，不自动映射成 host DAG。

### T00 — 固定 host 契约与实施基线

- 前置：C2 对 E1 或整包批准。
- 写入：`tests/subagents-host-contract.test.ts`、新增 `tests/fixtures/subagents-native-session.ts`；必要记录回本计划。不得改依赖或用户状态。
- 工作：固定 0.84.4 编译/0.85.1 host 的 delta JSON、终止事件、native append/reopen、context/compaction 以及 operations result shapes；为后续 real-host fixture 提供本地无凭据 fake provider，不跨真实 provider preflight。
- 完成/验证：`npm run typecheck`；`node --experimental-strip-types --test tests/subagents-host-contract.test.ts`。契约不符时定位接口，不由后续任务猜 API。
- 恢复：只修测试/适配；确需最低版本升级则停止该边界提版本决定，不改 lockfile 试错。

### T01 — 修复每 episode 最终报告完整性

- 前置：T00 的 JSON/settlement 契约 fixture。
- 写入：`extensions/subagents/protocol.ts`、`extensions/subagents/runner.ts`、`extensions/subagents/contracts.ts`、`tests/subagents-protocol.test.ts`、`tests/subagents-runner.test.ts`、`tests/fixtures/subagents/fake-pi.mjs`。
- 工作：最终 assistant 全部文本块、完整性字段、工具配对、终止原因、parser 每轮初始化、malformed/超限 framing；usage 事实保留，早期 error 不污染最终状态。空流/旧文本/length/toolUse/pending/无 settlement/异常退出不成功。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-protocol.test.ts tests/subagents-runner.test.ts`；确认这些失败不能触发 index 的 convergence，最终多块报告可被截断展示但完整性不丢。
- 恢复：保留旧结果读取，不回退到“exit=0 即成功”；协议缺口 fail closed 并保留诊断。

### T02 — 去除安全机械误拒，保持真实 containment

- 前置：T01 的失败/报告区分，避免可恢复拒绝产生假成功。
- 写入：`extensions/subagents/graph.ts`、`extensions/subagents/repository-policy.ts`、`extensions/subagents/path-policy.ts`、`extensions/subagents/child-capability-guard.ts`、`extensions/subagents/workspace.ts`、`tests/subagents-contract.test.ts`、`tests/subagents-repository-policy.test.ts`、`tests/subagents-guard.test.ts`、`tests/subagents-workspace.test.ts`。
- 工作：无权限 empty arrays 规范化；安全未执行拒绝非致命，manifest/边界失效保留致命；安全创建新文件缺失内部目录，准备/导出双重 containment；准确错误 stage/code，整批预检不丢 task。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-contract.test.ts tests/subagents-repository-policy.test.ts tests/subagents-guard.test.ts tests/subagents-workspace.test.ts`；非空越权、symlink/文件祖先、drift、未知改动负例仍通过。
- 恢复：只删除本次创建且为空的内部目录；部分 filesystem 故障保留 parent，不以扩大目录写权限修复。

### T03 — 建立统一 batch 时钟与 schema-v4 基础

- 前置：T01 的 contracts 改动落定；本计划串行放在 T02 后仅为共享集成文件的稳定修改窗口，不是语义硬前驱。
- 写入：新增 `extensions/subagents/telemetry.ts`；`extensions/subagents/contracts.ts`、`extensions/subagents/index.ts`、`extensions/subagents/scheduler.ts`、`extensions/subagents/render.ts`、`extensions/subagents/events.ts`、`tests/subagents-scheduler.test.ts`、`tests/subagents-extension.test.ts`、`tests/subagents-render.test.ts`、`tests/subagents-events.test.ts`；`.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts`、`.agents/skills/evaluate-subagent-runs/references/metric-schema.md`、`tests/subagents-evaluator.test.ts`（仅 v4 基础兼容）。
- 工作：tool-entry→result ready 单调 duration、独立 scheduler span、parent-observed child intervals、依赖/capacity/role/lock 等等待区间；progress 用真实 run clock，不用最大 child。v4 必需字段固定，后续 episode/command 字段可显式 unavailable；同时教 evaluator 识别 v4 基础字段和新时钟口径，不能让 E1 producer 先发布而 consumer 按 legacy 错算。完整跨轮消费留 T11。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-scheduler.test.ts tests/subagents-extension.test.ts tests/subagents-render.test.ts tests/subagents-events.test.ts tests/subagents-evaluator.test.ts`；并行/错峰/串行/提前拒绝/异常时钟/未闭合合成轨迹的 effort/union/wall 正确。
- 恢复：v1-v3 继续按旧义读取；performance 数据不可用不改变执行，必需结果证据不降级。E1 在此做 parent 综合 typecheck/test 后单独交付或继续。

### T04 — 接入可信 host worker 工具与独立目录

- 前置：T00 operations/host 契约；E1 通过 parent 综合验证。C1 已撤销，不需要镜像或容器。
- 写入：新增 `extensions/subagents/worker-tools.ts`、`tests/subagents-worker-tools.test.ts`；必要 fixture 新增 `tests/fixtures/subagents-worker-command.mjs`。不创建 execution config/backend 或修改 user config/routes；runner/role 接入在 T08。
- 工作：Pi 标准文件/搜索/bash 工具的同状态适配、任务 cwd/source/scratch 与依赖身份、workspace queue、命令退出/超时/取消、已知进程与临时资源清理、冻结前排空受管写者。使用普通可信 host 命令，不构建 shell 字符串权限分类器或 OS 沙箱。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-worker-tools.test.ts`；真实本地 edit→test→repair、工具交错、普通子进程取消、错误退出、scratch、两个 worker 不共享可写状态。无 provider/网络/容器依赖，不验证宿主资源不可访问。
- 恢复：只清理本次已识别的进程/临时资源，保留候选；状态或依赖不明如实阻塞，不提权、不安装或重放命令。独立 review 关注工具契约、数据与生命周期正确性，不验收 sandbox。

### T05 — 固定受管操作/结果契约

- 前置：T01 完整性与 T03 telemetry 基础；T04 工具/状态契约被 parent 接受（非自动依赖传递）。
- 写入：新增 `extensions/subagents/session-contracts.ts`、`tests/subagents-session-contracts.test.ts`；`extensions/subagents/contracts.ts`。
- 工作：第 3.2 节 action 输入、handle/request/version、候选/apply/unknown/no-change 结果与容量错误；旧 tasks schema byte-level 结构语义不变，fixed roles、不接受 raw session path/任意权限字段。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-session-contracts.test.ts tests/subagents-contract.test.ts`；create/continue 批量限制、非法 action shape、旧请求、幂等结果可表达，provider-compatible direct enum。
- 恢复：新 schema 未启用前修正；发布后未知版本拒绝，不读旧 diagnostic 为 managed。

### T06 — 实现最小 registry、身份锁与保留政策

- 前置：T05 的状态/操作/版本接口。
- 写入：新增 `extensions/subagents/managed-sessions.ts`、`tests/subagents-managed-sessions.test.ts`；`extensions/subagents/diagnostics.ts`、`tests/subagents-diagnostics.test.ts`、`tests/repository-boundary.test.ts`。
- 工作：native/registry/lock 分离、跨进程单写者、branch/owner 校验、request 去重及 unknown、idle slots 与 storage cap 分离、explicit close/discard、retention 不删未处理候选；旧 diagnostic inspector 保持只读，不能调用 mutating SessionManager.open。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-managed-sessions.test.ts tests/subagents-diagnostics.test.ts tests/repository-boundary.test.ts`；两个独立 Node 进程争同 handle、crash/ack 丢失、fork、symlink、quota、旧诊断、关闭重取均有 exact 断言。
- 恢复：锁不明不抢占、不删 registry 逃过容量；保留 interrupted 和候选，不自动修复 native 历史或运行消息。

### T07 — 实现跨 episode workspace 与候选 apply

- 前置：T02 的 filesystem 安全行为、T05/T06 的候选/存储接口。
- 写入：`extensions/subagents/workspace.ts`、新增 `extensions/subagents/candidates.ts`、`tests/subagents-candidates.test.ts`；`tests/subagents-workspace.test.ts`、`extensions/subagents/managed-sessions.ts`。
- 工作：source/scratch inventory、冻结身份、验证引用、B0/C1/E1/C2、依赖差异同步、owned drift、每路径 partial apply evidence、重复 apply 无操作。Legacy cleanup/no-change 不改义，managed 内部先用 edit-only fixture 验证状态。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-workspace.test.ts tests/subagents-candidates.test.ts tests/subagents-managed-sessions.test.ts`；C1 已/未 apply、第二文件 rename 故障、parent 外部写入、取消临界区、目录/symlink 变更、未知源码/临时恢复验证失效。
- 恢复：partial/unknown 不推进整轮 baseline；不自动 rollback，不整树同步覆盖候选。Parent 选择 fix-forward，额外文件/范围决定重新确认。

### T08 — 接入完整 worker 与受管轮次间通信

- 前置：T04 host 工具及其数据/生命周期 review、T06 registry、T07 candidate 算法及 parent 集成判断；不能用一个硬边跨过该 parent 决策。
- 写入：新增 `extensions/subagents/continuation.ts`、`tests/subagents-continuation.test.ts`；`extensions/subagents/index.ts`、`extensions/subagents/runner.ts`、`extensions/subagents/roles.ts`、`extensions/subagents/scheduler.ts`、`extensions/subagents/child-capability-guard.ts`、`tests/subagents-extension.test.ts`、`tests/subagents-runner.test.ts`、`tests/subagents-scheduler.test.ts`、`tests/subagents-contract.test.ts`。
- 工作：注册新工具；每 episode native reopen+append 新 prompt、fresh parser/current capability/leaf/route 验证、idle 释放 active slots、apply/close；runner 失效主动停止本任务受管命令。Role/guidance 按实际能力允许局部验证/repair 与内聚 singleton，保持 parent 裁决、无 child Skills/递归工具。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-continuation.test.ts tests/subagents-extension.test.ts tests/subagents-runner.test.ts tests/subagents-scheduler.test.ts tests/subagents-contract.test.ts`；worker C1→修复 C2、独立 reviewer 读新 revision→定向复审、question→answer、fresh reviewer、idle 无模型/slots、same handle 双写拒绝、本轮缺报告不取旧文。
- 恢复：旧工具仍可用且如实 edit-only；新能力故障时新路径拒绝，不自动换角色/模型/工作目录。更改 current route 只接受已有明确 ephemeral 权限，能力撤销立即失效。

### T09 — 实现 compaction/restart 连续性与真实 host 测试

- 前置：T08 的可用 handle/episode 与 T00 native fixture。
- 写入：新增 `extensions/subagents/context.ts`、`tests/subagents-continuity.test.ts`、`tests/subagents-native-continuation.test.ts`；`extensions/subagents/index.ts`、`extensions/subagents/continuation.ts`、`tests/subagents-host-contract.test.ts`。
- 工作：当前 owner 有限 registry/result 索引投影，guidance 幂等且尊重禁用；restart 只恢复可核对 idle。真实 Pi+local fake provider 验证 reopen 后第二输入与当前源码、自动/手动 compaction，观察最终 request tools/guidance；不让假事件代替宿主测试。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-continuity.test.ts tests/subagents-native-continuation.test.ts tests/subagents-host-contract.test.ts`。覆盖 threshold/overflow/manual、新请求/同 run、child compaction、resume/fork/tree/reload、后续 handler 改 payload、旧 running/撤权不重放。
- 恢复：兼容证据缺失就显式 unavailable/blocked，不重新启用工具，不重写 native compaction 格式；涉及 host 版本调整返回 C4。

### T10 — 采集 parent/child spans 与增量 usage

- 前置：T03 v4 时钟与 T08/T09 实际 episode/native 关联。
- 写入：`extensions/subagents/telemetry.ts`、新增 `extensions/subagents/observability.ts`、`tests/subagents-observability.test.ts`；`extensions/subagents/protocol.ts`、`extensions/subagents/runner.ts`、`extensions/subagents/continuation.ts`、`extensions/subagents/index.ts`、`tests/subagents-protocol.test.ts`。
- 工作：command/span/guard/capability/env/active/idle 事实、parent local-tool/wait/model/compaction 区间；native entry ownership、episode usage delta、summary/nested-tool accounting、partial/missing endpoints。只记录必要脱敏 scalar/opaque 关联，不持久化 payload/prose。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-observability.test.ts tests/subagents-protocol.test.ts tests/subagents-continuation.test.ts`；同历史多次读、retainedTail、结果重取、失败/retry、parent aggregate+child 同调用、缓存未知与真实 0 可区别。
- 恢复：性能写入失败返回 unavailable，不阻断任务；工作目录完整性/必需候选或诊断证据失败不以 telemetry 可选为由放行。

### T11 — 同步 evaluator 与 TUI consumers

- 前置：T10 冻结的 v4 producer fixtures；这是 consumer 的真实契约前置。
- 写入：`.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts`、`.agents/skills/evaluate-subagent-runs/references/metric-schema.md`、`.agents/skills/evaluate-subagent-runs/SKILL.md`、`tests/subagents-evaluator.test.ts`；`extensions/subagents/render.ts`、`extensions/subagents/events.ts`、`extensions/subagents-ui/component.ts`、`extensions/subagents-ui/render.ts`（只有确需新状态消费时触及）；`extensions/work-timing/index.ts`、`tests/subagents-render.test.ts`、`tests/subagents-events.test.ts`、`tests/subagents-ui.test.ts`、`tests/subagents-ui-integration.test.ts`、`tests/work-timing.test.ts`。
- 工作：evaluator v4 兼容 v1-v3/legacy，unknown 不补造；分别统计 mechanical/report/apply 与 parent acceptance。UI 消费 batch 真时钟与 idle/closed，work-timing 保留 v1 parent reasoning 口径及 headless inactivity，不抢 working/footer ownership。
- 完成/验证：`node --experimental-strip-types --test tests/subagents-evaluator.test.ts tests/subagents-render.test.ts tests/subagents-events.test.ts tests/subagents-ui.test.ts tests/subagents-ui-integration.test.ts tests/work-timing.test.ts`；合成三 worker 30 分钟 effort/10 分钟 union、成本去重与脱敏负例。
- 恢复：新版本缺字段显式 unavailable；不批量改旧 evaluation artifact、不从 mtime/prose 猜 provenance 或 quota。

### T12 — 完成集成验证、独立 review 与 truth-sync

- 前置：T00–T11 的可核查完成证据；parent 综合、必要 repair/受影响复验完成。
- 写入：`AGENTS.md`、`README.md`、`docs/architecture/subagents.md`、`docs/architecture/subagents-ui.md`、新增 `docs/architecture/subagent-execution.md`、`docs/README.md`；`tests/package.test.ts`、`tests/repository-boundary.test.ts`；必要时 `scripts/run-temporary-subagents-probe.sh`、`scripts/run-installed-subagents-probe.sh`、`tests/installed-subagents-probe.test.ts`；本计划执行记录。无关历史文件与其他 extension 不清理。
- 工作：在实际验证后更新 no-shell/single-shot/diagnostic-only 的适用范围、可信 host 执行范围/取消/部分 apply/续接/GC/removal、v4 观测及 parent 验收边界。新 tool 移除后无残留执行，保留用户受管数据不能静默删除；七个默认 extension load list 不变。必要 probe 只检测新 tool 可发现性，不触发推理。
- 完成/验证：第 6 节完整命令；源码/测试/真实本地工具与 native host 分层证据齐全，review 候选由 parent 裁决并修复。语义目标未完成不得只靠 npm check 宣布交付。
- 恢复：fix-forward；禁用新入口需明确 shutdown 与保留对象，不降级正在运行的任务。不得 commit/push/publish/install/reload 当前生产实例，除非另有明确授权。

### T13 — 执行获准的真实工作流观察

- 前置：T12 的机械交付、C3 的具体 provider/成本/时限/项目授权及有效安装/route/cap 的脱敏核对。
- 写入：`scripts/run-live-subagents-e2e.ts`、`tests/live-subagents-e2e.test.ts`，新增 `docs/evaluations/subagents/2026-09-07-full-worker-continuation.json`（实际观察日不同时改为实际日期）；记录文件不得含 raw 任务/路径/payload。新文件名在执行时固定后才可委派。
- 工作：有局部测试→修复的内聚 worker 与独立任务并行；parent 打回同 worker、同 reviewer 续审；拒绝恢复与 compaction 后继续；保留 resolved route、全部新增 usage、cold/warm、wait/active、parent disposition 与未测边界。
- 完成/验证：`CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents`，仅获安装验证权限时再加 `-- --installed`。既有 live script 当前只证明 one-shot 三角色，不可直接当新增能力验收。
- 恢复：按授权预算/取消停止，无 hidden retry/模型 fallback；关闭受管对象前处理候选。2→4 cap 或模型组合试验一次改一个因素且另获配置许可，无统一降本承诺。

## 6. 组合验证命令与当前证据

实施阶段清洁依赖安装仅在已获允许的 registry 网络/缓存条件下运行 `npm ci --ignore-scripts`；这不是本次文档任务的必要变更，也不授权依赖 lifecycle scripts。V1/V2/V3 在 `npm run check` 内，V3 只运行 disposable 本地命令。不存在 Docker 或 sandbox 验收 gate。

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
```

上述 probes 是当前维护要求，不改 `/plan` 也不省其回归。Installed probe pass 只表明被该 Pi 实例发现；临时与安装加载版本、配置、在途实例仍要分别报告，源码更新不表示已热更新。

Multi-skill mentions 的 temporary/installed probes 使用 print mode 且跨 provider preflight，不放 deterministic lane；`PI_OFFLINE=1` 只禁启动网络，不禁模型 inference。它们和 T13 一样需明确 provider-call 授权。

本次文档任务已执行的基线：类型检查通过；初测 237/238，唯一 repository-boundary 失败由根输入设计触发；按用户要求迁入既有 stage root 后该 suite 4/4 通过。未执行依赖重装、容器运行、真实 provider 工作流、用户配置变更、安装或提交。最终复验在第 9 节补记，不把计划中的命令写成已执行。

## 7. 并行与委派判断

本次现状调查已用一个 flat 只读 batch 覆盖执行边界、协议/续接、遥测三个切片，证据由 parent 对照代码核实；遥测切片未返回可用细节，相关结论由 parent 直接读取补齐。它不是未来实现的 DAG 或完成证明。

本实施计划默认串行，未声明 writable delegation-ready 任务。原因是 contracts/index/runner/workspace/registry/telemetry 的密集共享写入，以及工具生命周期、候选状态和跨轮集成之间必须有 parent 验证/裁决。没有用户明确要求 delegated implementation，不记录 model/profile 绑定，也不为潜在并行制造任务图。

只有在 T10 producer 契约被 parent 冻结后，T11 的 evaluator 与 UI consumer 才有潜在独立切片；当前仍保留为 parent-owned task。若届时选择委派，先固定实际存在的 exact write set、单仓 owner、隔离/资源锁、convergence owner、完成 oracle 与失败策略，再按当时契约拆分。Parent 综合验证、权限、review adjudication、repair 决定、续接和最终响应永不成为硬边后自动执行的 worker。

## 8. Review、恢复与升级边界

需要独立计划 review：新增 host 工具的同状态契约、持久可写会话和多轮 CAS 的数据丢失风险足以要求非作者视角。宿主权限按可信执行定位，不扩大为 sandbox 安全审计。审查目标是本计划对核实设计的忠实性、前置产物、权限 checkpoint、oracle 覆盖与可恢复性；不扩大成另一个产品设计。

实施期至少对 T04 的工具结果/工作目录一致性/受管命令生命周期，以及 T06–T09 的单写者/重启/partial apply 做独立 bounded implementation review。次数不预设为验收配额；parent 接受、拒绝或要求具体决定，修复后按受影响边界复验，只有证据已失效或有独立未解问题才定向复审。

新 runtime 关闭/回退以停新建、结束本实例写者、保留候选/registry、报告仍可恢复对象为顺序；禁止 Git reset/clean、覆盖 parent、删除不明锁、重放有外部副作用的命令。失效配置只影响后续 episode，不在正在运行任务中悄悄换模型/工作目录或扩大声明工作。

需要未来决定的触发：共同 Pi API 不足（版本支持）；真实项目缺少必要工具或依赖（具体任务缺口）；workspace footprint 超额度（显式配额）；可信 non-task input sync 无法保留候选（冲突协调）；有证据的启动开销/运行中通信需求（RPC）；有可比交付与费用证据后才讨论 cap/model 调优。以上均不授权自动迁移或弱化保证。

## 9. 文档交付与审查记录

- 本次授权写入：根 `pi-extensions-design-r1.md` 迁移改写为同目录 design，以及本 plan；不更新稳定架构为尚未实施的能力。
- 根 `CLAUDE.md` 初始不存在，不创建兼容文件。现有 `docs/AGENTS.md`、`docs/.ignore`、`docs/README.md` 已定义 stage root，无需改文档拓扑或扩大格式例外。
- 设计与计划只通过同目录相对链接关联；旧输入无仓库内引用需修复。保留 user R1 目标、限制、验收和复用需求，去除公开基线冒充现场/候选机制冒充已实现的歧义。
- 独立审查：2026-09-07，一名只读 reviewer 对本 plan、配套 design、AGENTS/docs policy 和 package 入口评估，verdict=pass，无 material candidate findings。Parent 接受该结论；它只证明计划一致性，不证明 runtime 已实现或授权 C1/C2/C3。
- 最终验证：`npm run check` 通过（typecheck、238/238 tests、shell syntax）；plan-mode/subagents/herdr-handoff 的 temporary/installed 六个 deterministic probes 全部通过。Installed 结果仅证明加载可发现性，不证明源码/route 与本 checkout 相同。
- 文档验证：使用 `contracts/markdown-prose.toml` 保留历史 immutable 例外，normalizer count/preview/write/check 均无本次待修 prose（write 实际零变更）；docs boundary checker、相对文件链接人工检查及 `git diff --check` 通过。未放宽任何断言/例外。
- 本节记录计划文档交付时的证据：当时尚未验证 C1 真实容器隔离、新功能 native 多轮/compaction、真实 provider 主动分工与经济性，且缺 C2 实施批准和 C3 实验权限。后续批准及实施状态以第 10 节为准，不将旧文档检查重解释为运行时证据。

## 10. E1 实施记录

用户后续批准按本计划实施。初始 HEAD 为 `ba3207b5e7938a2f052961a2031310efd72588cf`，工作区仅有本 design/plan 两份未跟踪文档；既有内容均保留。因 C1 未确认，本次只执行独立可完成的 T00→T01→T02→T03，未启动 Docker、构建/拉取镜像、修改依赖或用户配置，未安装、提交或推送。

- T00：新增无网络/无凭据合成 provider；开发 Pi 0.84.4 与 installed CLI 0.85.1 各以两个独立进程打开同一 native session，每次仅追加一个输入，验证 delta JSON、settlement、context/compaction tail 与共享 operations 状态。真实 stdout 经过 `JsonlProtocolParser` 的完整性断言。该 fixture 不证明受管续接已经可用。
- T01：最终报告合并全部文本块，清除后续活动之前的旧报告，要求完整 framing、最终 stop、settlement 与无未完成 assistant/tool；exit-zero 空流、截断及无效报告不得成功。保留 usage 和早期可恢复错误；`worker_no_changes` 未改义。
- T02：无权限空数组可接受，非空越权仍拒绝；普通安全拒绝允许纠正，能力/边界失效致命。新文件内部目录在 snapshot 准备，apply 时检查并创建 parent 目录；canonical root 包括祖先 symlink 检查。仍是逐文件 rename，不保证多文件事务或无竞态。
- T03：统一 parent 单调 clock，区分 tool-entry→result（含 admission/cleanup）与 scheduler；记录 child 端点及有界重叠等待原因。Runtime/evaluator v4 与文档同步，旧 v1–v3 保持原义，缺失/倒退/非有限端点为 unknown；effort、occupied interval wall 与 provider utilization 不混用。未实现 episode/command/parent acceptance 新证据。

独立实施 review：安全/报告与 timing/evaluator 两个有界切片并行审查。T03 无 material finding，文档版本提示已同步。安全 review 的两个候选均 `accepted`：malformed terminal event 可复用旧报告；root 祖先被 symlink 替换后可越过原 canonical 边界。三个 red regressions 重现后修复。定向复审发现首次修复误把原生 delta update 当完整 message，亦 `accepted`；两版本实际 stdout→parser 测试先 red 后 green。最终定向复审 `pass`；祖先边界修复的既有 pass 保持适用，无 accepted finding 未解决。Reviewer 仅静态审查，命令验证与裁决由 parent 完成。

最终候选验证：`npm run check` 通过 typecheck、255/255 tests 与 shell syntax；plan-mode/subagents/herdr-handoff 的 temporary/installed 六个 deterministic probes 全部 pass；`git diff --check` 通过。Installed probes 仅证明可发现性，不证明运行中实例或安装字节与 checkout 一致。未运行 multi-skill print 或 live subagent provider lanes，未据合成时间宣称生产并行收益。

E1 当时可交付；当时整体 outcome=`needs-authority`，因为原 C1 environment record 仍缺镜像/资源/容器许可。该 C1 状态已由后续用户范围决定撤销，不再作为当前阻塞；剩余功能未因此完成。C3 实验/安装/config 权限仍须单独给出。

后续历史：用户曾回复 `approve and continue`，当时将 C1 缩小为环境参数待确认，未启动容器。随后用户明确指出 sandbox/container 设计与验收属于扩展范围之外；本计划已据此撤销 C1，移除相关模块与验收，不能再要求这些参数或按旧授权启动容器。完整 worker、续接、候选与遥测目标继续保留。

## 11. 范围修订与当前候选验收收尾

用户明确排除 extension 自有 sandbox/container 设计、配置和安全验收，并要求继续验收收尾。本次修订 design 第 4 节及本计划 C1/T04/V3 等相关规范，保留可信 host 工具、工作目录、候选/状态/生命周期验证；未删除 E1 的文件 guard、symlink、drift 等回归，也未把目录机制宣传为任意 bash 的安全边界。历史检查与曾经的 C1 等待仅作为历史记录保留。

本轮两个独立只读 reviewer 分别审查设计边界与执行计划，均为 `pass`，无 material findings；parent 接受。该审查只证明范围修订一致，不代替 runtime 实现验收。E1 代码自上次最终实施审查后未再修改，原 accepted findings 的修复与定向复审证据继续适用。

当前工作区候选基于 HEAD `ba3207b5e7938a2f052961a2031310efd72588cf`，保留全部 E1 变更及两份 stage 文档，未产生其他实现写入。本轮重新运行 `npm run check`：typecheck、255/255 tests、shell syntax 全部通过；plan-mode/subagents/herdr-handoff 的 temporary/installed 六个 deterministic probes 全部通过。文档仍遵循既有 immutable prose exceptions；installed probes 仅证明可发现性，不证明当前加载字节、routes 或运行实例与本 checkout 一致。

收尾判定：E1 与本次职责边界修订可 `closed`；完整功能目标为 `needs-implementation`，不再是缺 C1 权限。当前 worker 仍仅有 read/grep/find/ls/edit/write，尚无 `worker-tools.ts`、受管 session/episode、显式 candidate apply 或完整跨轮 usage collector。T04–T12 保持未完成，最小下一步为已授权的 T04 host 工具接入；T13 仍是 C3 单独授权的观察，不将未实现功能改成可选或已验收。

未执行 Docker、依赖重装、全局安装、用户配置修改、真实 provider 工作流、commit/push/publish/deploy；仅使用已有本地依赖、无网络合成 provider fixture 和明确的独立审查调用。不存在为收尾而回滚、清理用户工作或降低运行时断言。

## 12. E2 实施进展与 T10 边界

后续用户要求继续实施；本轮保持 E1，完成 T04–T09 的主体接入及本地验证。新 `csheng_subagent_sessions` 提供 create/continue/inspect/apply/close；worker 使用可信 host 工具、同一私有源码目录和原生 child history，reviewer 在后续 episode 读取实际更新的 parent 文件。Parent 仍负责语义裁决与显式 apply；没有 Docker、sandbox、安装或配置 gate。

- T04：native schemas/image read、同目录工具 FIFO、真实 edit→失败测试→repair→成功测试；普通 bash/search 后代取消、超时与 drain，不宣称对抗恶意逃逸。
- T05–T08：有界 registry/native 分离、单写者、不回收 unknown lock、owner/anchor/episode/native-leaf 校验；B0→C1→C2、显式 apply/reapply、部分 apply 前缀和中断保留；create/continue 缓存结果不重新 launch，也不依赖已失效的执行 routes。
- 工作输入补齐：`worker-inputs.ts` 创建私有 Git/index，不创建 commit、不复制 parent Git metadata；复制已有 ignored `node_modules`，保留 worker-local dependency 状态，parent 依赖变化时仅替换相应输入。Managed 源码 inventory 不按 gitignore 隐藏未知改动，记录目录 mode，冻结候选同时绑定源码与私有输入身份。源码 admission 与候选大小检查是数据边界，不是 OS 磁盘配额或执行安全隔离。
- T09：每请求投影当前 owner 的有限索引，幂等且尊重禁用/撤权，不复制旧报告或自动 resume。两套真实 Pi 运行时验证 reopen、manual/threshold/overflow compaction、同进程 reload 后请求、tree/fork、后续 payload handler；child compaction 后续轮必须实际看到 summary、读取先前源码及未导出的本地依赖状态，且保留 source/cache inode，不能靠无条件重写通过。
- 独立 review 的 material 候选均由 parent 接受修复：replay/候选/进程边界；quiet compaction malformed error；reload oracle；分阶段依赖 symlink 链及复制前源码引用；有界 snapshot 的 unstaged deletion；Git-isolation 与 child-continuation oracle。最后定向复审为 pass，未另开 sandbox 安全审计。

在固定两个互不交叉的新 helper 契约、exact write set 和 parent 集成边界后，使用过一次平行 worker batch：collector 写入收敛；inputs worker 超时且未收敛，随后由 parent 本地完成，没有自动重试、替换指定模型或修改持久 routes。其余集成、验证、裁决与修复均保持 parent 所有权。

本进度点的 `npm run check` 为 316/316 tests、typecheck 和 shell checks 全部通过；六个既有 deterministic probes 通过。该批 probes 尚未新增 managed tool 可发现性断言，不能冒充 T12 新入口验收。未执行真实 provider 工作流、安装、当前生产实例 reload、用户配置修改或 commit/push。

T10 在本进度点只有纯 native observability collector 与测试：有界增量范围、直接 assistant/summary usage、native owner/entry 去重、unknown 与真实 0、opaque scalar 投影。其 runtime hooks、parent/child 跨轮关联和 consumers 当时尚未接入；316 tests 不是完整功能交付结论。后续状态见第 13–14 节；T13 仍须独立 C3 授权。

## 13. T10 collector 接入与修复验收

T10 已接入真实 parent/child 公共事件、同域单调时钟、native physical append range、worker command 与 configured capability/environment scalar 事实。Parent 普通 turn、闲置 shutdown 和禁用工具不写观察；没有新的 timer、UI slot、provider/config owner、dispatch 或 lifecycle engine。使用公共 `pi.appendEntry`，不调用 mutating session-open 或修改历史。Summary/nested aggregate/retained prefix 的 accounting 所有权分开，真实 0 与 unavailable/null 不混同。

可选 episode sidecar 与 required registry/request/terminal ACK 分离。重取结果按原 episode hydrate，cached request 不新启动或重复发布 run；sidecar 丢失/损坏/写失败不改变已提交结果、候选或 apply。Native/source/candidate/mandatory writer lifecycle 失败仍显式拒绝。

两个独立 review findings 均 accepted 并修复：最终 thinking block 全无 stream endpoints 时不得 complete-zero；可选 observation 占额不得使 peer required commit 或 terminal ACK 失败。前者加 bounded endpoint 核对和 done-only-thinking 原生 oracle，后者精确回收 session-root derived cache、预留 ACK 增量、postflight 与最终 rehydrate；保留真正 required 超限失败。两项定向复审均 pass。

真实两版 Pi 同进程 create→cached replay→continue oracle 保留三个 parent observations、run 数 `[1,0,1]`、相同 child owner 与不同 episode/process clock。Parent direct input 各 2，两次唯一 child episode 各 2，owner-dedup 总计 10 而非 12；不自动 apply。T10 最终 `npm run check` 为 341/341、typecheck、shell checks 全绿；此前旧 handler/command-shape oracle 已按真实公共契约修复，没有削弱协议或必需数据断言。

## 14. T11–T12 本地交付与关闭边界

T11 增加只读 `observation-metrics.ts` 和 frozen synthetic producer-shaped fixture，既有 evaluator v4 legacy counters 明确限定 one-shot。新 observations 消费 owned native ranges、episode/replay、parent/child usage、同域 worker effort/union、parent/child reasoning/local-tool/compaction、command coverage/endpoint changes、configured tools/window/manifest 事实。三 worker 各十分钟的 fixture 精确给出三十分钟 effort/十分钟 occupied wall；两版真实 native producer 直接进入 consumer，仍为 10 个 owned input tokens、两个唯一 episode 和两条 command。Unknown 或丢失证据不补为免费、空闲、server utilization、quota 或验收。

显式 `--disposition` 只接收 bounded parent JSON、owner 与有序 entry-range。缺省/显式 null 保持 unknown，真正 0 保留；不从 prose、report、candidate 或 apply 推断 acceptance。Epoch selector 不猜 managed envelope 缺少的 effective revision pair，相关记录 unavailable；新 native 指标用 exact-session 读取，不伪装成完整 epoch 经济性。

Managed model content 改为 bounded、可解析 JSON，先保留全部 handle/episode/candidate 再截报告；TUI 区分当前请求失败、存储 idle/closed、episode outcome、report、apply 与 unavailable acceptance。进度接既有 scheduler/run clock 和 host tool-update channel。Optional subagents-ui panel 仍仅消费 one-shot snapshot；work-timing v1 和 headless inactivity 未改，不新增其 slot/timer 所有者。

T11 使用一个 flat 双 worker batch：render 两文件收敛；metrics worker 超时且未收敛，parent 接管本地实现，未自动重试或改持久 routes。Parent 修复 render 草稿语法、UTF-8/budget/header 保留，并用实际 host oracle 验证。后续独立 review 的 nullable disposition 与 capability-snapshot conflict 两项 findings 均 accepted；补 shared stable-evidence signature、双顺序负例与 null/0 oracle。Parent 另修 unavailable-owner fork attribution 与 CLI error prose/path redaction。最后 targeted rereview 与 stable-truth review 均 pass，reviewer 未冒称自行执行测试。

T12 同步 README、AGENTS、architecture/subagents、独立 subagent-execution truth、optional UI 边界、docs index 与 maintainer skill/schema。两个 subagent probes 新增 managed discovery 和 extension-off absence；shim 负例拒绝 legacy-only installed discovery。六个 temporary/installed plan-mode、subagents、Herdr RPC probes 均通过，不调用模型；installed 结果只证明新 probe 进程可发现工具，不证明当前生产实例已 reload 或与本 checkout/route 完全同版。

最终本地源码候选仍在原 dirty checkout，HEAD 未改变，E1 及后续有权变更均保留。`npm run check` 为 357/357、typecheck、shell syntax 全部通过（`/tmp/pi-e2-e3-final-check.log`）；编辑的两个 probes 通过 shellcheck，immutable-aware Markdown 与 docs boundary、`git diff --check` 通过。Package/lockfile、packaged routes、plan-mode/Herdr/work-timing 实现未改；未安装、重装依赖、reload 当前生产 Pi、修改用户配置或 commit/push/publish/deploy。

关闭判断：T04–T12 的 E2/E3 本地机械实施、条件 review、修复和 truth-sync 完成；E1 继续保留。T13/C3 真实 provider semantic workflow、经济性、安装及 route/cap 实验未执行，仍需独立授权；现有 live script 仍是一轮三角色 probe，不作为新 managed continuation 的真实交付证据。没有重新引入 C1/sandbox 阻塞，也不把 synthetic 通过宣称为真实任务收益已证明。

## 15. 更新与 Git 交付授权

用户后续明确要求更新 Pi extensions、close change、smart commit 和 push。已确认本包通过当前仓库的 local source 直接加载，执行定向 `pi update --extension <本仓库> --no-approve` 成功；没有扩大到其他 package、Pi 本体、model catalog 或用户 routes。更新后 installed plan-mode/subagents/Herdr 三个 RPC probes 再次通过，其中两个 subagent tools 均可发现、extension-off 时均消失。新进程加载验证不等于当前生产 Pi 内存实例已经 reload。

Git preflight 确认目标为本仓库 main、既有 upstream 为 origin/main；fetch 后没有超前/落后提交，没有预先 staged 变更或活动 Git hooks，也没有仓库内 GitHub workflows。按功能实现、package discovery 验证、稳定契约与实施记录分组交付；授权包括现有远端的正常 push，不包括 force、改写历史、发布或 T13 真实 provider 观察。既有 357/357 最终实现证据与完成的 review 继续适用，源码没有因更新命令改变。
