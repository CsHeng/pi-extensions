# Pi Extension 与 Skills 边界研究报告

**研究基准：2026-09-18。状态：外部静态研究与待验证建议，不是已完成的本地组合审计，也不是获批的迁移方案。**

本文依据委托书中的本地基线和下列固定公开源码。没有运行用户的 Pi、子代理、provider、MCP、Bark 或 Herdr，没有修改用户配置、仓库或安装。公开源码能够说明“该路径怎样工作”，不能说明当前进程已经走过该路径。

证据记号沿用委托书：**L-config** 为委托方配置/安装事实，**L-source** 为委托方本地源码事实，**P-source** 为本报告核对的固定公开源码，**R-observed** 为真实运行观察；本报告没有新增 R-observed。**条件性结论**指机制已由源码成立，但当前配置、顺序或输入是否满足尚未确认；它不同于已经复现的故障。文中 `[H…]`、`[O…]`、`[S…]`、`[C…]`、`[M…]`、`[W…]`、`[K…]` 均链接到固定提交的文件和行范围；跨 agent 官方文档按访问日引用。

本地基线来源：`2026-09-18-pi-extension-and-skills-boundary-research-request.md`，特别是第 30–118 行。安装、配置选择、进程加载、功能激活必须分别记录。

---

## 1. 一页结论

### 1.1 最重要的判断

**不建议把现有 Skills 整包迁到 Pi extensions。** 真正应该分开的，是持续偏好、按需方法、工具接口事实和程序能够负责的状态约束。现有 `implement-change` 已把语义验收留给主代理，把身份、revision、执行关联等机械一致性交给宿主；这是可继续保留的边界，而不是需要推倒重建的障碍。[K1] · [K3] · [K8]

**当前优先级最高的不是 `rg` 提示放在哪里，而是工具所有权和真实执行路径。** CC 与 SoL 都在 `session_start` 才注册 `write`。Pi 跨 extension 的同名工具采用“已解析 extension 顺序中第一个获胜”，不是自动叠加 wrapper。CC 先注册时可能遮蔽 SoL 的 `write.then_run`；SoL 先注册时 CC 会让位，但失去自己执行链采集的 write-diff metadata。机制确定，本地顺序与命中情况未知。[H2t] · [H5t] · [C2] · [C3] · [S1] · [S3]

**SoL fusion 不是两个普通 Pi 工具调用的省略显示。** `then_run` 在文件工具内部直接调用新建的 builtin bash definition；它不再经过独立的顶层 bash preflight 和事件轨迹。因此，仅监听顶层 bash 的权限提醒、计时或证据观察器不能把内部命令视为已经覆盖。文件先修改，后续命令失败也不会回滚文件。MCP 嵌套调用同样需要区分外层 Pi 工具与内层操作，不过 adapter 自己仍有内部 approval 路径，不能笼统说成“绕过全部审批”。[S4] · [H7] · [M3] · [M4]

**“停止后又继续”至少有三个扩展侧生产者。** `workflow` 在条件满足的 settlement 后请求 follow-up；SoL online compaction 会主动 abort、compact，再请求新 turn；`pi-web-access` 的后台内容取回或 curator 提交也能请求新 turn。真正运行 loop 的仍是 Pi。`agent_end`、`agent_settled`、`isIdle` 和 `waitForIdle` 不是可互换的业务完成信号。[O16] · [O17] · [S7] · [W2] · [W2b] · [H5p] · [H7]

**`rg` / `fd` 的推荐很具体：把短的持续偏好放入已有全局 `AGENTS.md`，复杂选择知识继续留在 Skill。** Pi 原生 `grep`、`find` 的默认本地实现已经分别用 `rg`、`fd`；不要因为工具名字叫 `find` 就强制改用 bash。bash-only 默认提示提到 `rg` 和 `find`，却不等价于“文件发现优先 fd”。`APPEND_SYSTEM.md` 在此版本选择受信任项目文件时不会再自动合并全局文件，所以它不是这条全局偏好的首选承载点。[H1] · [H1c] · [H4] · [H8] · [H9] · [K1]

### 1.2 已避免与仍未知

`work-timing` 与 CC 独立 working-message writer 的共存条件已经在委托方配置中满足：`enableWorkingMessage:false`。这不是一个已复现冲突。`status-footer` 也不拥有 working line；不过 CC 的 renderer、summary、write override、references 等能力并未因此关闭。`plan-mode` 和 RPIV extension 被排除，不应列为当前第一嫌疑人。SoL 的 evidence reducer 全局关闭，也不能当作当前结果压缩的已知来源。以上均仍受项目覆盖、其他加载路径、旧进程影响。[C1] · [C4] · [H3]（L-config：委托书第 58–97 行）

**尚未补齐：三个 npm 包的发布 tarball 与 release 源码逐字节对应关系；RPIV 2.10.1 的固定发布源码；本地 resolved extension 顺序、有效配置与实际工具 owner/schema；两项 loose integration 的外部接收端；组合运行与真实模型效果。** 九个自维护入口均已检查介入边界，但本报告不声称审计了所有 helper、存储事务、取消竞态或第三方 provider 分支。

### 1.3 前三项待处理事项

1. **先形成启动后的工具所有权回执。** 优先验证 CC/SoL 的 `write`、`edit` schema 与 owner，以及 fusion/MCP 嵌套操作的事件边界。收益是把组合行为从“包都装了”变成可判断的事实。
2. **再验证 continuation 与恢复。** 使用 fake tools、disposable session 检查 SoL 的 intentional abort 与 workflow barrier、web 回调之间的关系；不先新增 scheduler。
3. **最后做小范围偏好拆分与删重。** 只处理 R1/R2、持续输出偏好和恢复底线；保留 R3–R5、条件 review、父级验收等 portable semantic core。先证明实际注入，再讨论模型服从度和费用收益。

Pi-only 时，直接维护已有 Pi 全局指令是最小方案。仍使用 Codex/Claude Code 时，建议 **portable core + 单一共享偏好源 + 薄宿主入口**；不为了跨 agent 形式一致而抹平其指令发现、工具权限和续跑机制。

---

## 2. 固定版本来源与覆盖账本

### 2.1 版本锚点与证据强度

| 对象 | 固定锚点 | 本次实际取得的证据 | 不能由此推出的事实 |
|---|---|---|---|
| Pi | `0.85.1`；`d981de1229ef899957bbe968bc8dcda02a21f477` | 对应 tag/release 与固定源码；检查 resource loading、runner、AgentSession、agent loop、prompt、search tools 和模式文档。 | 用户所有存量进程均为此版本；SDK 采用默认 resource loader。 |
| 自维护 extensions | `f86a72dd985224dcbd415de00e14771c69552e63`；manifest `0.1.0` | 九个入口及关键交叉模块；发布快照与 checkout 一致来自 L-source。 | 日常进程直接加载 checkout；单看 `0.1.0` 能识别快照。 |
| Skills | `e0d4a230fc70355181709b911ab4b546177b13b4` | authored 重点 Skill、preference contract、shell、安全/实施边界、`contracts/skills.toml`、代表性发布文件。 | 所有 generated 文件已做字节比对；所有 agent 当前均已加载正文。 |
| `pi-mcp-adapter` | `2.31.0` → `eca6e8e14746f2a093e5d3085ccc244832962d71` | 固定 release 对应公开源码；入口、script、proxy call、error signal。 | 已安装 npm tarball 与仓库每个文件相等；所有 server/transport 已审计。 |
| `pi-web-access` | `0.29.0` → `192ac1875e3b8f88c78953dbc314949ec9fcaa27` | 固定 release 源码；四类工具、后台 continuation、curator、session 与 UI 入口。 | 每个搜索 provider、浏览器/视频/PDF 处理模块均被深入核对；本地功能都激活。 |
| `pi-cc-extensions` | `0.8.71` → `e43e0041b59f5d7f03be9b9d103a5f9e954e4c11` | 固定 release 源码；配置默认值、全部入口能力、关键 write 与 UI/reference 机制。 | `/ccstyle off` 等价卸载；peer 范围之外一定运行失败。 |
| `SoL-Pi` | `bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1` | 四个 feature 注册、配置解析及三项选择开启功能的关键实现；关闭的 reducer 查介入点。 | `package-lock.json` 修改无运行影响；整个安装 pristine；全局四个布尔值就是最终值。 |
| `@juicesharp/rpiv-todo` | `2.10.1`，L-config | 查明 Pi `extensions:[]` 排除该资源类型的语义；未取得此版本固定发布制品。 | 可以用 `main` 或其他版本替代审计；没有其他显式加载路径。 |
| `agent-bark.ts` | SHA-256 `d421b4af8e6ff18336b8502587b9cd9e10ee3b5f18c761e132a6b8b624c7dcbe` | 仅委托方 L-source 摘要。 | hook 实际可用、发送网络通知成功、当前已加载。 |
| `herdr-agent-state.ts` | integration v8；SHA-256 `9b1c41cd72520fc2abe5f2a2aec995c12a926cce844df472c7fd5fcae4f4dbfa` | 仅委托方 L-source 摘要。 | 环境条件满足、socket 接收端协议与状态解释已经验证。 |

版本链接：[V1] · [V2] · [V3] · [V4] · [V5] · [V6] · [V7]。npm 的结论严格称为“该版本对应的 release 源码结论”，不是“已验证部署制品结论”。本次 registry/tarball 获取未成功，**不等于项目永久不可公开访问**。RPIV 的缺口是固定版本证据未取得，不是断言仓库私有。

### 2.2 自维护九个入口逐项覆盖

| 入口 | 已检查的行为与关键文件 | 明确保留的深度缺口 |
|---|---|---|
| `plan-mode` | 工具集合快照/恢复、branch-local 状态、system guidance；`index.ts`。[O1] | 当前禁用；不对未来与任意动态工具注册者的所有顺序作保证。 |
| `multi-skill-mentions` | `$` mentions、Skill command 查询、正文读取、input transform/handled、autocomplete。[O2] | 未在三套 autocomplete 组合下跑真实 TUI。 |
| `fast-gpt` | branch entry、command、模型过滤、`service_tier` payload 修改。[O3] | 实际 provider 接受、路由改写与计费无观察。 |
| `subagents` | tool 注册、continuation、child CLI、roles、worker-tools、capability guard。[O4] · [O5] · [O6] · [O7] · [O8] · [O9] | managed store/candidate apply/锁/崩溃恢复未做全量事务审计；没有启动 child。 |
| `herdr-handoff` | 显式 handoff 工具、支持契约、prompt 提醒、coordinator 生命周期入口。[O10] | coordinator/client 深层错误矩阵、实际 Herdr 服务与 recipient 未验证。 |
| `status-footer` | `setFooter`、状态读取、会话/模型更新与 listener 生命周期。[O11] | 所有终端宽度和第三方 footer patch 的最终视觉组合未跑。 |
| `work-timing` | stream/tool/settled 观察、working writer、completion entry 与 timer 清理。[O12] | 指标与 provider 实际 compute time、各种等待类别没有标定。 |
| `subagents-ui` | observer 校验、widget/overlay、session generation 与清理。[O13] | 未做真实交互及所有丢事件/乱序轨迹试验。 |
| `workflow` | v2 goal tool、prepared input、tool observation、context reminder、settlement barrier。[O14] · [O15] · [O16] · [O17] · [O18] | 全部 goal-state reducer 与候选/证据迁移组合没有逐路径审计。 |

### 2.3 第三方功能与被排除能力的覆盖

CC 的入口不只是渲染：aliases、docked-bash flush、startup header、working message、markdown transformer、style/compact-thinking、`/context`、session references、agent mentions、agent summary 均列入后文。默认 feature 布尔值为开启；委托方只明确关闭独立 working writer。其 manifest 对 Pi 的 peer 声明为 `^0.84.0`，不包含 `0.85.1`：这是**声明的兼容范围缺口**，不是已复现故障。[C0] · [C1] · [C2] · [C4] · [C5] · [C6] · [C7] · [C8] · [C9] · [C10] · [C11] · [C12] · [C13] · [C14] · [C15]

MCP 已覆盖 `mcp` gateway、direct tools、namespace proxy、`mcpScript`、初始化等待、错误位修正、prompt/command/status 与清理入口；OAuth、transport、output materialization、worker VM 的全部安全细节未完成。Web 已覆盖 `web_search`、`source_check`、`fetch_content`、`get_search_content`，以及 curator、后台消息、存储恢复和 UI；各 provider 实现未逐一审计。[M1] · [M2] · [M3] · [M4] · [M5] · [W1] · [W2] · [W3] · [W4]

SoL 的三个开启候选功能不是同一类压缩：action fusion 改工具接口和执行路径；observation pack 改本次上下文投影；online compact 改 session 压缩与 continuation。被关闭的 evidence reducer 是 `tool_result` 改写者，若将来开启，会比 context-only packing 更早改变结果及其入史内容；目前只查到这个边界，不评价其完整 reducer 质量。[S1] · [S3] · [S5] · [S7] · [S9]

`rpiv-todo extensions:[]` 与 `plan-mode` 的排除成立于**该配置解析路径**。CLI `-e`、其他 package/project/loose 路径仍要看最终回执。`pi-mcp-adapter skills:[]` 只排除该包的 Skills，不能用来证明 adapter 已关闭。[H3]（L-config：委托书第 58–65 行）


## 3. Pi 原生链路、介入权限与行为表

### 3.1 主链及重复边

```text
资源解析、trust、加载与 session 恢复
  → 常规 prompt 入口：commands → input → Skill/模板展开 → before_agent_start
  → Agent loop：context 投影 → provider payload → 流式消息 → 工具批次 → 后续 turn
  → steering / follow-up / retry / compaction 分支
  → agent_end → Session 层剩余工作 → agent_settled → 已持有的 idle barrier 释放

旁路：显式命令、用户 !bash、UI/editor、外部 I/O、tree/switch/reload、shutdown。
回边：queued follow-up、扩展 triggerTurn、web 后台回调、SoL 压缩后 continuation。
```

这不是保证每个事件只出现一次的流水线。特别是内部 custom-message continuation、忙碌时入队消息与常规用户 `prompt()` 并不重新经过完全相同的入口。以下地图只描述固定 host 的默认实现，SDK 自定义资源和工具仍可改变边界。[H5] · [H7]

| 阶段 | Pi 原生负责什么 | 本组合的主要介入者 | 判断边界 |
|---|---|---|---|
| 资源/信任 | 解析 package 资源过滤、全局/项目/CLI 路径，加载工厂，建立 runtime；project trust 决定相关项目资源能否参与。 | MCP 工厂注册/缓存工具；CC 工厂及启动回调；SoL 启动后注册；两个 loose 候选。 | factory 成功不等于 feature 初始化成功；必须在 `session_start` 之后检查工具。 |
| 输入 | extension command 可先消费；`input` 链转换/短路；随后常规 Skill/模板展开。 | multi-skill；MCP 初始化等待；workflow/SoL 输入观察。 | 原始输入、展开后用户消息、extension 来源消息不能混为一类。 |
| 启动指导 | 构造 base system prompt，运行 `before_agent_start`，收集 system 改写和 custom message。 | subagents/handoff/plan guidance；CC references；Bark 等待。 | 某些改写仅属本轮 system override，custom message 则进入历史。 |
| 请求上下文 | `context` 对 messages 的克隆投影进行链式改写，再转为 provider 输入；payload hook 更晚。 | workflow reminder；SoL packing/compact accounting；fast-gpt payload。 | 早期 context hash 不能证明最终 wire payload。 |
| 输出/工具 | Agent 发消息事件；校验工具名与参数；运行 preflight、execute、result 转换；串行或并行批次。 | CC UI/summary；timing；workflow observation；SoL fusion；MCP nested calls。 | 直接调用 ToolDefinition.execute 不自动重入 Agent 的全部事件。 |
| 后续工作 | 消费 steering/follow-up；处理 retry、自动 compaction 和 post-run 工作。 | web 回调、SoL、workflow 分别生产后续消息/请求。 | 扩展请求 continuation；host loop 才执行。 |
| 结束/恢复 | Session 层发 settled；reload 发 shutdown、invalidate old runner、重建资源与 runtime。 | timing completion、workflow barrier、SoL compact、Bark、Herdr；各扩展重放/清理。 | settled 不是“所有未来 callback 永远停止”，reload 也不是任意 Node 副作用的强制回收。 |

原生消费者证据：[H1] · [H2] · [H3] · [H4] · [H5] · [H6] · [H7]。扩展生产者见后续行为表。

### 3.2 同名事件不共享统一合并规则

在固定实现中，extension 列表和每个 extension 的 handler 注册列表决定遍历顺序；普通 dispatch 串行 `await`。loader 也按已解析路径逐个等待 factory。但“配置里某个数组看起来在前”不是完整 resolved 顺序证明，factory 内异步注册、`session_start` 动态注册和脱离 awaited 链的 timer 都可能改变某项能力何时存在。跨事件或后台 callback 不能据此推导全局串行。[H2] · [H6]

| 事件/API | 能力与合并/失败语义 | 需要避免的误解 |
|---|---|---|
| `project_trust` | 首个明确 yes/no 决定短路；undecided 继续。 | 所有 extension 都无条件等到项目受信任才执行。 |
| `input` | 逐个消费当前 text/images；transform 传给后续，handled 短路。 | 多个返回值被自动拼成一条用户消息。 |
| `before_agent_start` | system prompt 链式替换；返回的 custom message 收集追加；异常报告后继续其他 handler。 | 最后一个 handler 的快照就是完整 provider 请求。 |
| `context` | 先克隆消息集合，再按返回值链式替换；普通异常继续。 | 改动一定写回 session history，或者彼此一定可交换。 |
| `before_provider_request` | 对已经组装的 payload 链式替换；未返回新值不触发返回式替换。 | 此处只能观察，不能改变工具表/文本等 payload 字段。 |
| `before_provider_headers` | 共享 headers 对象允许修改。 | payload 是所有请求改写的最后边界。 |
| `tool_call` | 位于有效工具/参数准备之后；block 短路；handler throw 使工具失败，不按普通事件吞掉继续执行。 | 一个抛异常的安全 guard 会像 UI observer 一样 fail-open。 |
| `tool_result` | content/details/isError/usage 按字段合并并传给后续；异常报告后继续。 | 所有 result hook 都只能改变显示，或只有最后一个对象生效。 |
| `message_end` | 可以链式返回同 role 的替代消息；Session 同步更新对象和后续持久化。 | `message_end` 天然是只读观察事件。 |
| `user_bash` | 首个有效处理结果接管该路径。 | 用户 `!bash` 与模型 bash、extension `pi.exec`、内部 bash 都经过相同 hook。 |
| 一般事件及 `session_before_*` | 一般异常报告后继续；before-session 类可 cancel，返回对象合并并非通用 fieldwise 策略。 | 任何事件抛错都中止 host；所有 before hook 都支持相同阻断权。 |
| `registerTool` | 同一 extension 的同名 Map 项可更新；跨 extension 第一个同名定义获胜；registry 刷新后可覆盖 builtin；SDK custom tool 还有自己的合并层。 | 后注册永远覆盖一切；两个 wrapper 自动串起来。 |
| commands / shortcuts / renderers | commands 的重名 invocation 可加后缀；shortcut 冲突与保留键有单独规则；message renderer 也有自己的查找顺序。 | 所有注册型 API 都和工具同名冲突一样。 |

精确 dispatch：[H2]；工具注册与刷新：[H2t] · [H5t] · [H6]；真正的工具消费者：[H7t]。这里没有把可用的 `registerTool`、`setActiveTools` 推导成一个未核实的通用 `unregisterTool` API；MCP 的 feature detection/fallback 也不能反过来证明 host 存在该 API。[M1]

### 3.3 哪些改动进入历史

| 改动位置 | 典型去向 | 本组合例子 | 排障应对照什么 |
|---|---|---|---|
| `input` transform / 常规 Skill 展开 | 变成随后提交的用户内容；若 handled 则可能根本没有本次用户消息。 | multi-skill 展开。 | 输入来源、最终 user message 的 fixture marker，而非只看 editor。 |
| `before_agent_start.systemPrompt` | 当前 run 的 system override；不是新增聊天条目。 | delegation guidance。 | base/override 指纹与最终发送边界。 |
| `before_agent_start.message` / `sendMessage` | custom message，依具体调用和队列时机加入 state/history；display 只控制展示。 | CC session references、web 后台结果、SoL continuation。 | customType、role、entry、投递时机；不能把 hidden 当成不发给模型。 |
| `context` 返回值 | 请求投影，不直接替换原始 session 条目。 | SoL packing、workflow reminder。 | 原始 tool result、投影后 content、final payload 分别比对。 |
| `tool_result` / `message_end` 替换 | 可影响 Agent state 与保存的消息。 | MCP error 位；未来开启的 SoL reducer。 | 变换前后错误位、content/details 与持久化副本。 |
| `before_provider_request` | 本次 provider payload；没有自动的 session 历史回写。 | `service_tier`。 | 最后 transport adapter 收到的结构，而非 transcript。 |
| `appendEntry` | session custom entry；不等于自动增加一条模型消息。 | goal state、timing、plan/packing ledger。 | branch entry 与哪个 context/tool 负责投影它。 |
| 真正 compaction | 写 compaction 相关记录并重建有效上下文范围；不等价于删掉整个 session 文件。 | host automatic/manual；SoL 调用 `ctx.compact`。 | summary、保留边界、branch 与重新注入的系统/extension 状态。 |

消费者证据：[H5] · [H5p]；提示构造：[H4]；生产者：[O14] · [O18] · [S5] · [S7] · [M5] · [C7] · [W2]。

### 3.4 完成、队列、续跑的契约

`agent_end` 结束的是 Agent loop 的一次运行，不保证 Session 的 retry/compaction/后续任务全部结束。`agent_settled` 在 Session 收尾处发出；发出前已把 active 标记置为 false，但 handler 仍按顺序等待。因而**在 settled handler 内临时调用 `waitForIdle`，与此前持有、等待全部 settlement handler 完成的 barrier 不是一个时刻的观察**。workflow 正是通过更早建立 waiter 和 session/epoch lease 来避免仅靠“看见 settled”就续跑。[H5] · [O17]

`sendUserMessage` 请求普通用户消息路径，忙碌时按 delivery mode 排队；`sendMessage` 发送 custom message，`triggerTurn`、`deliverAs` 和当前 streaming 状态共同决定是否启动/入队/仅追加。`nextTurn` 可以存放待后续提交消息而不立即启动；idle 的 `triggerTurn:false` 不启动推理。绑定给 extension 的发送接口不是“await 到模型工作全部完成”的 completion API。内部 custom-trigger 路径也不等价于再次调用完整的用户 `prompt()` 入口。[H5]

`pendingMessageCount` 不能当成外部工作清单：它不替你统计任意 timer、网络请求、工具内部的操作、通知 hook 或所有 custom-message 暂存。更不能用零队列推出“任务语义验收通过”。工具批次默认/设置支持并行，而某个 tool 声明 sequential 可以影响整批；fusion 与 MCP 的内部并行/顺序要分别建模。[H5] · [H7] · [S4] · [M3]

### 3.5 非事件 API 与权限边界

| 机制 | 合适用途 | 不能承诺的保证 |
|---|---|---|
| tool description、`promptSnippet`、`promptGuidelines` | 说明实际工具参数、适用范围、输出边界；随 active tools 构造指导。 | 模型必然遵循；字符串相近的规则被语义去重。 |
| `setActiveTools` | 改下一阶段可见/可调度的工具名集合。 | extension 本身、内部直接调用、Node I/O、远端 server 的能力被撤销。 |
| commands、shortcuts | 显式用户操作入口；可调用 session 控制。 | 每次普通输入都经过这些入口。 |
| `ctx.ui.*`、renderer、Markdown transformer | UI 状态、展示与交互。 | UI 写入自动进入模型上下文；不同 setter 是同一 mutation target。 |
| `pi.events` | extension 间协作与观测传输。 | host 安全边界、可信身份认证或全局完成判定。 |
| `appendEntry` / session API | branch-local 状态、事件证据、恢复标记。 | 条目天然具备业务验收意义，或模型自动看得到它。 |
| `ctx.compact` / abort / follow-up API | 请求宿主已有控制动作。 | extension 获得独立 scheduler、无限重试权或新增授权。 |
| prototype / renderer patch | 当前无公开接口时的深度 TUI 适配。 | host 会自动撤销所有补丁，或升级时仍有同一对象形状。 |
| `pi.exec`、Node API、Worker、child process、socket | 具体工具与集成的执行能力。 | 受顶层 `tool_call` 完整拦截；天然隔离文件、网络与凭据。 |

Pi 的公共 API 与生命周期消费者见 [H2] · [H5] · [H6] · [H10]。CC 既使用公共 API，也使用 prototype/内部 TUI patch；不能统一归为“纯公共插件 API”。worker 的源码自己将 bash 定位为 trusted-host cooperative 执行；候选导出检查不是 OS sandbox。[C2] · [C6] · [C14] · [O8]

### 3.6 模式不是一个 `hasUI` 布尔值

| 加载/运行面 | `mode` / UI | 可以发生的行为 | 本组合注意点 |
|---|---|---|---|
| TUI | `tui`；hasUI true | 完整组件、editor、交互与工具。 | footer/working/overlay 需要检查具体 owner。 |
| RPC | `rpc`；hasUI true | 部分 UI 通过协议交互；TUI custom 组件不可按原样使用。 | 只检查 hasUI 的扩展不能据此认为自己处于 TUI；workflow 允许的模式与 observer UI 不同。 |
| JSON / print | `json` / `print`；hasUI false | extension 仍可注册工具、改 prompt、I/O、追加消息。 | CC write override 并非只在 TUI；SoL 还专门处理 print 的续跑生命周期。 |
| SDK | 由 SDK 绑定 context、mode、resource loader、tools | 可以不同于默认 CLI 发现/持久化策略。 | memory session 没有可供 SoL archive 使用的 sessionDir；不能从 CLI 结果推定 SDK 等效。 |
| managed child | `--mode json --print` 等显式参数 | 关闭自动 extensions/Skills/templates；仅加载指定 guard，角色工具与 append 指导。 | 没有禁用 context files，不等于必然失去全局 AGENTS；却不会自动继承父 extension prompt/工具注册。 |

模式文档与 runner：[H2] · [H10]；child 实参：[O6]；SoL sessionDir 要求：[S8]。`--no-extensions`/`--no-skills` 也不应被解释为拒绝所有显式 CLI 资源：测试时须核查显式 `-e`、`--skill` 等。[H1] · [H11]

### 3.7 行为表：自维护 extensions

此表中的“开启”表示相应 feature 在该进程实际加载且满足条件；并不是本报告观察到本地激活。统一禁用原则：**F** 表示改有效 feature 配置并重新初始化；**E** 表示排除实际入口；**P** 表示 fresh process。`/reload` 可重建正常生命周期，但 prototype、timer、外部进程的确定清除需要核验，A/B 优先 P。任何一种都不默认删除历史。[H5]

| ID | 所有者/版本/功能 | 激活条件与模式 | Hook/API/机制 | 原生行为 → 改后行为 | 共享目标与组合语义 | 状态/持久化/清理 | 隔离/恢复 | 证据/未知 |
|---|---|---|---|---|---|---|---|---|
| O01 | own fixed / plan 工具限制 | 当前 E；启用后 plan mode | `setActiveTools` | 当前工具集合 → builtin-source 的只读集合。 | 全局 active-name 集合；不是叠加权限策略。 | 保存并恢复原工具名快照；branch 状态。 | 保持禁用；未来退出后验 schema/owner，必要时 P。 | [O1] · [H5]；没有当前冲突证据。 |
| O02 | plan 指导/恢复 | 当前 E；已保存 plan 状态 | `before_agent_start`、session events | 添加 plan guidance、重放状态。 | system prompt 链；恢复旧 snapshot 可能覆盖他人后续选择。 | branch entry；不是全局配置。 | E+P 不自动清除旧 branch entry。 | [O1] · [H2]。 |
| O03 | multi-skill 输入展开 | 直接输入匹配 `$skill`；跳过 extension 来源 | `input` | 基于已发现 Skill 读取正文并转换用户输入。 | user text；同 Skill 去重，不是额外发现引擎。 | 无业务状态；读取失败 handled 并提示/恢复 editor。 | E+P；新输入不再展开，旧消息保留。 | [O2] · [H2] · [H11]。 |
| O04 | multi-skill 补全 | TUI | session start、autocomplete wrapper | 为已有 provider 加 mentions 补全。 | editor autocomplete，和 CC 共用对象链。 | 随 editor/session；实际组合未跑。 | 单独 E；fresh editor 检查 `$` 与 `@`。 | [O2]。 |
| O05 | fast-gpt 请求改写 | 支持的 provider/API/model 与 branch 选择 | `before_provider_request` | 修改请求 `service_tier`。 | payload 字段；可能被后续改写者覆盖。 | priority/default/untouched 状态另见 O06。 | 改命令选择不是“撤回已发请求”；E+P 还原无此 writer。 | [O3] · [H2]；不证明价格或生效。 |
| O06 | fast-gpt 状态 | 命令及 session/model/tree | command、`appendEntry`、keyed status | 保留并显示 branch 选择。 | entry 与 `fast-gpt` status，不拥有 footer。 | branch-local entry。 | E 停未来操作；保留历史便于恢复。 | [O3] · [O11]。 |
| O07 | subagents managed delegation | 显式有界调用、角色/配置/信任通过 | `csheng_subagent_sessions` | create/continue/inspect/apply/close；前台等待 episode。 | managed record、candidate；parent 决定 apply 与验收。 | 保留 native history/working state；关闭释放 slot，不等于删全部证据。 | E+P 停新调用；按显式 close 处理已有任务。 | [O4] · [O5]；深层事务未全审。 |
| O08 | child 执行约束 | managed role-specific child | CLI `-e` guard、原生 tool wrappers | 受控工具集、路径/临时资源检查；worker 可 bash。 | child registry、源码工作区和 scratch；不是父 registry。 | 进程组/超时/退出清理；worker 工具 FIFO。 | 停派发并检查残留 process/record；不删存储目录代替恢复。 | [O6] · [O7] · [O8] · [O9]；非 OS sandbox。 |
| O09 | subagents 指导/归属观察 | 工具 active 与配置满足 | `before_agent_start`、输入 provenance | 向 parent 说明能力/验收边界；记录关联。 | prompt、observations；不创建新 scheduler。 | 当前 session/调用关联。 | E 或 role/config 定向调整后 P。 | [O4] · [O18]。 |
| O10 | Herdr 显式 bridge | 明确用户 handoff 意图、支持协议/信任 | `herdr_handoff`、`pi.exec`、coordinator | 对指定外部收件方 handoff/return/transfer。 | 外部 Herdr/进程，不是 subagents-ui 调度。 | coordinator 生命周期；shutdown 入口。 | E+P 停新派送；已外发不可由卸载撤回。 | [O10]；接收端未知。 |
| O11 | Herdr 工具指导 | tool active | `before_agent_start`、status command | 加入使用边界与诊断信息。 | system prompt；与 O10 的真实执行分开。 | session runtime。 | E；历史保留。 | [O10] · [H2]。 |
| O12 | status-footer | TUI | `setFooter`、状态/event 读取 | 替换默认 footer，展示选择的 keyed 状态/usage。 | footer 单一 setter；不写 working line。 | listener dispose；读到 status 不保证每一项都显示。 | E+P 恢复默认 footer。 | [O11]；布局未实测。 |
| O13 | work-timing working writer | TUI run/stream/tool | events、`setWorkingMessage`、timer | 显示本地事件推导的时间/进度。 | working line；和 CC 独立 writer 互斥。 | run-local spans/timers；settled/切换清理。 | E+P；不要同时启用 CC writer。 | [O12] · [C4]；当前共存条件已配置。 |
| O14 | work-timing completion | 符合 settlement 条件 | `agent_settled`、entry/renderer | 增加完成计时记录/展示。 | completion entries，不等于业务完成。 | session 历史可保留和重放。 | E 停新增；不抹旧记录。 | [O12] · [H5]。 |
| O15 | subagents-ui | TUI、合法 observer snapshot | event bus、widget、overlay | 只读显示 managed delegation。 | keyed widget/overlay；无 apply/accept 权。 | generation/revision 检查；session/tree/shutdown reset。 | E+P；调度能力应不变。 | [O13]。 |
| O16 | workflow completion contract | 显式 enroll/有效目标 | `csheng_workflow`、session entries | 管理 goal/revision/report/close 等机械一致性。 | branch-local ledger；不自动判定测试通过。 | v2 状态；旧格式不等于自动可写迁移。 | suspend/close 要符合目标语义；E 不能伪造完成。 | [O14] · [O15]。 |
| O17 | workflow 输入与上下文 | 能关联实际送达消息 | `input`、`message_start`、`context` | 对齐用户/extension 来源，并投影 reminder。 | 当前 context；不是仅凭 raw text 推定身份。 | 收据/epoch；移除过期投影。 | E 对照最终 canary；原始目标记录保留。 | [O16] · [O18] · [H2]。 |
| O18 | workflow 工具证据观察 | 当前 goal 与有效 tool identity | tool start/end | 绑定 observation 与执行结果。 | 顶层 call ID/结果；融合内步无独立 observation。 | 关联 host outcome，不负责语义接受。 | fake tool A/B；保持 record 与 trace。 | [O16] · [H7] · [S4]。 |
| O19 | workflow continuation | TUI/RPC、信任/active tool/未完成目标及 barrier 条件 | `agent_settled`、waiter、`sendUserMessage` | 在 host 安全边界请求普通 follow-up。 | queues 与 session/epoch lease；host 执行 loop。 | abort/error/stale 等阻止或 suspend；不是无限循环授权。 | suspend 合法停止跟踪；E+P 用于隔离，保留 pending 实际任务。 | [O16] · [O17] · [H5]。 |

### 3.8 行为表：MCP 与 Web

| ID | 所有者/版本/功能 | 激活条件与模式 | Hook/API/机制 | 原生行为 → 改后行为 | 共享目标与组合语义 | 状态/持久化/清理 | 隔离/恢复 | 证据/未知 |
|---|---|---|---|---|---|---|---|---|
| M01 | MCP 2.31.0 gateway | extension 加载；配置/metadata 决定可用操作 | `mcp` tool | status/search/describe/connect/auth/call 等统一入口。 | 一个顶层工具内路由远端操作。 | connection/cache/runtime owner。 | E+P；不删认证资料作为首选。 | [M1] · [M4]。 |
| M02 | MCP direct tools | 配置/环境选择、缓存或连接完成 | 动态 `registerTool`、arguments preparation | 远端 schema → 直接 Pi tool。 | 全局 tool registry；元数据变化可改变 schema/active 集合。 | metadata cache、注册状态。 | 关闭对应 direct 选择后初始化并验 owner。 | [M1] · [M2] · [H5]。 |
| M03 | MCP namespace proxies | namespace 配置适用 | namespace tool sync | 增加按 namespace 路由入口。 | 内层 MCP 调用≠独立 Pi tool events。 | runtime/cache；入口随同步变化。 | 定向配置或 E+P。 | [M1]；namespace helper 未全审。 |
| M04 | MCP `mcpScript` | 默认除非 scriptMode=false | Worker + proxy executeCall | 一个 Pi 请求内循环/过滤/扇出 MCP 调用。 | 内层记录/approval 与 Pi 外层分层；非全局 sandbox。 | timeout/abort、worker termination、操作摘要。 | F+P；在 fake manager 上测内层 trace。 | [M3] · [M4]；完整 worker 安全未审。 |
| M05 | MCP 初始化等待 | session start/input，未收敛状态 | session init、`input` await | 输入可能等待 server/tool 初始化。 | input 时间；不等于模型思考。 | owner signal、超时/失败状态。 | 用离线 stub 区分等待；E+P。 | [M1]。 |
| M06 | MCP error 位修正 | 任意 tool_result details 命中特定错误码 | `tool_result` | `tool_error`/`call_failed` → isError true。 | fieldwise merge；predicate 未按 tool name 命名空间限制。 | 影响后续状态/历史错误位。 | 构造其他工具同码 fixture；E 对照。 | [M5] · [H2]；当前跨包误命中未知。 |
| M07 | MCP prompts/commands/status | metadata、显式命令与 UI 条件 | prompt commands、status/event bus、OAuth UI | 增加操作入口和 MCP 状态。 | status 可被 footer读取；auth/配置命令有副作用。 | cache、认证/连接、binary resource 生命周期。 | E 停未来入口；授权/已外发操作需各自撤销。 | [M1]；未运行认证/网络。 |
| W01 | Web .29.0 search | webSearch toggle；provider 能力可用 | `web_search` | 搜索/多查询/可选内容/curator；返回有来源的结果。 | 单个 Pi tool 内多外部请求；source text 非天然可信指令。 | responseId、结果存储、activity。 | F 或调用不取内容/不使用 curator；隔离用 E+P。 | [W1]；provider 分支未逐审。 |
| W02 | Web source check | sourceCheck toggle | `source_check` | 形成 bounded research artifact 和 passage citations。 | artifact 是证据组织，不是宿主语义验收器。 | store + `web-search-results` entry。 | 定向关此工具；保留旧 artifact。 | [W3]。 |
| W03 | Web fetch | fetchContent toggle | `fetch_content` | readable/raw/answer；支持图像、仓库等类型的分支。 | 抽取/回答与原始 HTTP body 非同一结果；可能外部 I/O/clone。 | fetched content/cache/responseId。 | 指定受控 fixture 分支；E+P 清未来工作。 | [W3]；下游各格式实现未全审。 |
| W04 | Web stored retrieval | getSearchContent toggle | `get_search_content` | 分页/片段查找已有结果。 | content 截断与 retrieval handle；不等于重新搜索。 | 当前恢复后的结果 store。 | 只测固定 responseId；E 不删除历史 entry。 | [W4]。 |
| W05 | Web 后台结果 | includeContent/后台请求尚有效 | callback、`sendMessage(triggerTurn:true)` | 工具已返回后仍可追加内容并请求模型继续。 | host queue/run；不能把工具返回视为所有网络结束。 | pending fetch ownership；session 变更/关闭 abort。 | 不发真实搜索，用受控 deferred callback；E+P。 | [W2] · [H5]。 |
| W06 | Web curator/UI commands | 显式命令、shortcut、浏览器/选择条件 | custom UI/browser、follow-up message | 人工选择结果后可继续请求；配置命令可持久写入。 | browser/widget/queues 与工具调用分开。 | sessionActive、curator 生命周期。 | 关闭 curator 或 E+P；已外发请求不可撤回。 | [W2b]。 |
| W07 | Web session 恢复/清理 | session start/tree/shutdown | events、append/read entries | 重建结果视图、释放 widget/请求/clone cache。 | branch/store/cache，不是系统 prompt。 | cleanup 实现可见，实际残留未测。 | disposable session A/B；保留证据而非删整个目录。 | [W1] · [W2]。 |

**一个小但明确的加载断口：** MCP 包的 `mcpScript` description 会让模型加载 `mcp-scripting`，而本地排除了该包的 Skills。若没有其他同名来源，这条提示指向不存在的已发现 Skill。它不使脚本工具失效，但会造成指导缺口或多余查找。先查发现清单，成立时只补这一条入口或删去悬空引用，不必恢复整包 Skills。[M1]（L-config：委托书第 60 行）

### 3.9 行为表：CC、SoL 与 loose 边界

| ID | 所有者/版本/功能 | 激活条件与模式 | Hook/API/机制 | 原生行为 → 改后行为 | 共享目标与组合语义 | 状态/持久化/清理 | 隔离/恢复 | 证据/未知 |
|---|---|---|---|---|---|---|---|---|
| C01 | CC .8.71 style/tool cards | TUI、style 配置与 patch owner | renderer/prototype、tool grouping/mouse | 替换/折叠展示。 | host TUI 私有对象；不是仅 keyed widget。 | patch registry/所有权与重绘回调。 | mode off 可测渲染差异；完整隔离 E+P。 | [C2]；不保证跨版本对象形状。 |
| C02 | CC write metadata | session_start，未发现 external write owner | `registerTool(write)` | builtin write → 采集前态 metadata 的 wrapper。 | 与 SoL 争同名工具；与 TUI 开关不同。 | runtime store 与 call ID。 | E+P 才是干净隔离；验 schema/owner。 | [C3] · [C2] · [H2] · [H5]。 |
| C03 | CC compact thinking | TUI/显示设置 | AssistantMessageComponent patch、流事件 | 改思考展示、折叠与时间信息。 | 与 CC style 的 updateContent 也需主动争/复合 owner。 | patch teardown、部分时间 entry。 | E+P；不把显示消失当模型内容丢失。 | [C6]。 |
| C04 | CC Markdown | extension 注册 | `registerMarkdownTransformer` | 处理链接、提示框、diagram 等显示。 | render 文本，不是 context hook；每 extension 单槽。 | 模块缓存/transformer。 | E+P；比较 transcript 与 render。 | [C5]。 |
| C05 | CC session references | 默认开，输入匹配已有 session ref | `before_agent_start` | 读取被引用会话并追加 custom message。 | 跨 session 内容、persistent custom entry；并非单纯补全。 | session cache/generation 与清理。 | 关 enableSessionReference+P。 | [C7] · [H5]；无读取私有会话实验。 |
| C06 | CC agent mention 指导 | 默认开、存在 agents 定义、输入匹配 | `before_agent_start` | 追加要求使用 `Agent` 的指导。 | prompt tool name 与 own `csheng_subagent_sessions` 不同。 | agents cache；resources discovery 重置。 | 关 enableSubagentAutocomplete+P；先验是否真的有 `Agent`。 | [C8]；当前触发未知。 |
| C07 | CC references 补全 | TUI，session/agent 数据可用 | 延迟 autocomplete wrappers | 扩展 `@` 候选。 | 与 multi-skill 共用 provider 链；异步时机需测。 | generation 防 stale；deferred callbacks。 | 两项分别关，fresh editor A/B。 | [C7] · [C8] · [O2]。 |
| C08 | CC 独立 working writer | 本地显式 false；默认原本 true | turn/stream/end、timer、working setter | 自定义 working 文案与计时。 | 与 O13 同一 setter，已配置避免。 | run timer；end/shutdown 恢复。 | 保持 false，不作为首要当前嫌疑。 | [C1] · [C4]。 |
| C09 | CC agent summary | 默认开；达到工具计数条件 | tool events、`agent_end`、appendEntry | 增加 agent-summary 记录/展示。 | 与 O14 是不同 custom entry，完成定义也不同。 | 每 run summary；session history。 | 关 enableAgentSummary+P，只停新增。 | [C9] · [C10]。 |
| C10 | CC context command | 默认开；显式命令 | `/context` | 展示 context/tool 使用估计。 | 诊断 UI，不是 final payload 观测器。 | 临时计算/显示。 | 关 enableContextCommand；不影响真实context链。 | [C11]。 |
| C11 | CC aliases | 默认开；显式 `/clear`、`/exit` | commands、newSession/shutdown | 新会话/退出的别名。 | 宿主 session 控制，不是普通消息。 | 生命周期由 host 接管。 | 关 enableAliases+P。 | [C12] · [H2]。 |
| C12 | CC header | 默认 showStartupHeader；hasUI | `setHeader`、session lifecycle | 替换 startup header。 | header setter，与 footer/working不同。 | shutdown 恢复；实际 UI能力随mode。 | showStartupHeader=false 只关 header。 | [C13]。 |
| C13 | CC docked-bash flush | 工厂即安装 | InteractiveMode prototype wrapper | 用户 bash 完成后补 flush 行为。 | 非普通 tool hook；补丁 owner/重装逻辑。 | 进程级 patch；完整卸载效果未测。 | E+P，不能用 style off 代替。 | [C14]。 |
| S01 | SoL 配置/注册 | 首次 session_start | `initialized` + loadConfig + register | 按有效配置注册四项功能。 | 动态工具/handler；全局文件可能被项目文件替代。 | initialized 在加载前置 true；配置失败需重新初始化。 | 修复有效配置+reload，关键隔离用 P。 | [S1] · [S2]。 |
| S02 | SoL action fusion | 有效 actionFusion=true | 覆盖 edit/write，`then_run` | 文件操作之后内部执行 builtin bash。 | tool-name owner、内部 I/O；不是两个顶层调用。 | 每路径串行队列、hash 检查；不回滚已改文件。 | F+P，确认两种 schema 都恢复。 | [S3] · [S4] · [H7]。 |
| S03 | SoL observation pack | 有效 flag、sessionDir、符合大小/类型/次数条件 | `context` | 旧大段成功纯文本观察 → archive 引用/摘要投影。 | content 投影；保留 message 身份字段。 | session archive 与 ledger；不自动证明全生命周期 GC。 | F+P 还原未来投影；该投影本身不删历史，另有compaction须另算。 | [S5] · [S6] · [S8]。 |
| S04 | SoL observation recall | packing 注册可用 | `obs_recall` | 有界按 archive 引用读取内容。 | recall handle 与文件存储；不是所有被压缩信息自动恢复。 | 校验/offset/bounds；依赖 archive 仍在。 | 用固定 archive fixture；勿先删 archive。 | [S5] · [S6]。 |
| S05 | SoL plan representation | onlineContextCompact=true | `update_plan` sequential tool | 表达计划/进度，并触发可压缩边界判断。 | plan claims 不是 workflow 的 goal/evidence ledger。 | branch plan entries、economics 状态。 | F+P；不把 plan completed 当验收。 | [S7] · [S10] · [O15]。 |
| S06 | SoL online compaction/续跑 | 完成边界+经济判断+宿主条件 | turn_end abort；settled compact；triggerTurn | 主动切断当前 run、压缩并继续。 | abort signal、queues、compaction、waiter。 | 支持恢复、tree/shutdown cancel；print 生命周期特殊处理。 | 单关此 flag+P 做 A/B；保留其他 SoL 功能。 | [S7] · [H5] · [O17]；组合轨迹未知。 |
| S07 | SoL evidence reducer | 全局 false；最终值须核对 | `tool_result` | 可能把结果改为有证据引用的 receipt。 | 比 context packing 更早影响结果/历史。 | archive/journal/可能额外模型调用。 | 当前保持关闭；不进行 provider probe。 | [S9]；内部 reducer 未全审。 |
| X01 | agent-bark loose | 实际被自动发现/加载 | before_agent_start、settled await 本地 hook | 增加本地进程等待与可能通知。 | event latency；向 stdin 输出 session/cwd/≤300字符摘要。 | 每次上限 5500ms；接收端未知。 | 仅此入口 E+P；本报告不触发通知。 | L-source，委托书105行。 |
| X02 | herdr-agent-state loose v8 | 环境满足、实际加载 | session/agent/UI/herdr:blocked → socket | 向 Herdr 上报状态/session引用。 | 外部状态通道，不等于 O10 handoff。 | socket接收端与重启清理未知。 | 此入口 E+P；只查脱敏发送计数。 | L-source，委托书106行。 |
| X03 | RPIV 2.10.1 | 当前配置 extensions=[] | package资源过滤 | 该包 extension 不应由该路径进入运行时。 | 无已证明的当前 mutation target。 | 旧进程/别的路径未知。 | 保持排除，先验 loaded清单，不重装。 | [H3] + L-config；固定包内部未覆盖。 |


## 4. 交互判断与按症状排障

### 4.1 必须分成四类，而不是统一叫“冲突”

| 交叉点 | 分类 | 因果判断 | 当前仍缺的条件 |
|---|---|---|---|
| work-timing ↔ CC working writer | **配置已避免** | 同一 working setter，两个 timer 确有竞争可能；本地已经显式关闭 CC 那一个。 | 进程是否读取该配置、是否旧进程。 |
| footer ↔ fast-gpt/MCP keyed status | **共享信息但可安全组合** | producer 写 keyed status/event，footer 读取选择的信息；不是多个 footer writer。 | 是否需要展示当前 footer 未渲染的其他 status。 |
| work-timing completion ↔ CC agent-summary | **可以共存，定义不同** | 不同 entry 类型，分别看 settled 与 agent_end；可能信息重复，但不等价于互相覆盖。 | 用户是否认为重复有成本，是否把其误当同一个耗时。 |
| CC ↔ SoL write | **确定的所有权/顺序依赖** | session_start 动态注册，同名 first-wins；CC 的“外部 owner 已存在”检查不能预见随后才注册的 SoL。 | 实际 resolved顺序、schema及owner。 |
| SoL then_run ↔ 顶层 bash guard/observer | **确定的执行面差异** | 内部调用新建 bash.execute，顶层仅出现 edit/write；隐藏 active bash 并不撤销这条内部能力。 | 当前是否有依赖 bash name 的 guard、模型是否用了 then_run。 |
| MCP script/proxy ↔ Pi tool observer | **确定的粒度差异** | Pi 外层事件不自动展开每个 remote call；adapter 内层 approval/operation log 是另一个面。 | 观察器是否消费这些内层记录；不能假定 approvals 全部缺失。 |
| multi-skill ↔ workflow prepared input | **已有组合设计，不是天然冲突** | workflow 关联实际 message_start/context，不只比较最初 raw text；普通展开可保留正确对齐。 | 所有 input/source/队列来源在组合中是否仍唯一对应。 |
| workflow context ↔ observation pack | **共享目标，未证实破坏** | packing 主要换 tool-result content，保留身份字段；不会仅因此删除 custom entries。 | 某项语义判断是否依赖被替换正文；真正 compaction 后如何重建。 |
| SoL intentional abort ↔ workflow barrier | **源码支持的组合风险，运行未知** | abort 可令 waiter lease 失效，而 SoL 自己又 compact/triggerTurn；可能导致 workflow suspend或不再续跑。 | 嵌套 settlement、注册顺序和 goal state 的受控轨迹；未证明死锁或无限循环。 |
| web callback ↔ workflow/SoL continuation | **多个合法生产者，运行未知** | 各自可以在模型表面停止后生产消息；队列先后由时机与 host 决定。 | callback owner失效、pending queues、compaction期间到达行为。 |
| CC @agent ↔ own subagents | **条件性工具语义不匹配** | CC 指导使用 `Agent`，own 注册另一工具名；有匹配 agent 文件和输入才触发。 | `Agent` 是否另有真实 owner；agents 定义是否存在。 |
| MCP error hook ↔ 其他工具 details.error | **条件性跨包影响** | adapter 的错误码 predicate 没有限定工具名；其他工具同码也会被改 isError。 | 当前是否有其他工具用相同 code表达非失败。 |
| 三套 autocomplete wrappers | **共享 mutation target，结果待测** | `$`/`@` 语法不相同，但都包装 editor provider；CC 部分安装延迟执行。 | wrapper是否保留delegate、reload后重复层数和fallback。 |
| plan-mode restore ↔ 动态 registry | **未来风险；当前禁用** | 恢复旧 active-name snapshot 可能覆盖另一个设置者后来选择。 | 只有重新启用才进入验证优先队列。 |

证据配对：工具与 dispatch [H2] · [H5] · [H7]；own [O1] · [O2] · [O11] · [O12] · [O16] · [O17] · [O18]；CC [C2] · [C3] · [C7] · [C8] · [C10]；SoL [S1] · [S3] · [S4] · [S5] · [S7]；MCP [M3] · [M4] · [M5]；Web [W2]。

### 4.2 三条最重要的因果链

**A. CC/SoL 的问题不是“谁后执行谁覆盖”。** Pi 先按 extension 顺序取得工具定义，再建立 registry。CC 先启动时，看到的是 builtin write，注册其 wrapper；SoL 后来虽注册同名 write，也会在跨 extension 去重时落败。反过来，SoL先启动，CC 发现外部 owner后主动不注册。于是“调整顺序”可以选择所有者，却不能得到二者全部执行能力的自动组合。候选处置是明确 write 的唯一执行 owner，或者让 CC 的纯展示适配接受外部执行者；这需要独立设计/测试，不是本报告替用户立即排序。[C2] · [C3] · [S1] · [S3] · [H2t] · [H5t]

**B. then_run 的成功/失败需要分阶段表达。** 文件 mutation 已成功后，内部命令可能失败、被取消或超时。外层 error 不证明文件未变；外层成功也不等于完成用户业务验收。对 workflow 最合理的短期解释是“一个有复合副作用的工具 observation”，不是虚构第二个 bash observation。若未来要求每个 shell 操作单独经过 guard，应让内部执行显式委托一个受支持的统一边界，或暂时关闭 fusion；不要在 observer里伪造 host events。[S4] · [H7t] · [O16]

**C. 压缩丢失必须先问丢的是哪一层。** observation pack 对成功纯文本的大结果建立 archive，达到发送计数条件后替换请求中的正文；这一层保留消息身份，不等于删 history。archive 的原文是该 hook 所看见的版本，也可能已经包含更早工具结果变换；它不是“从最初执行器获得的绝对原始结果”。其计数也不是 provider 已成功接收的网络回执。online compaction 才进入 session 压缩/恢复控制面；二者应分别 A/B，不能一个开关关掉整个 SoL 后就归因。[S5] · [S6] · [S7] · [H2] · [H5]

### 4.3 按症状的最小排障入口

以下都是待授权的后续验证方案。先在 disposable settings/session 重现相关表面，再考虑读真实环境的脱敏清单。每轮只改变一个 owner/feature，且证明目标确实加载。

| 症状 | 可能写入者，按相关性排序 | 只读证据 | 最小 A/B 与区分信号 | 回滚方式 |
|---|---|---|---|---|
| 模型收到意外文本 | multi-skill；CC session/agent references；workflow reminder；SoL/web custom message；全局/项目指令。 | source/role/customType、fixture marker、stage fingerprint、最终 fake provider 输入。 | 原生输入 vs `$skill` vs `@reference`；依次关相应 input/reference feature；先区分 system/custom/user/context-only。 | 恢复原配置并 fresh process；保留被注入历史用于取证，不继续拿已污染session当clean baseline。 |
| 工具消失、形状改变或被阻断 | CC/SoL write owner；MCP 动态 direct/namespace；active-tools选择；guard；未来才是plan-mode。 | session_start后tool names、sourceInfo owner、schema hash；有效config；preflight error。 | CC-only、SoL-only、双向order；预期write是否含then_run、owner是否变化。对guard另测throw/block。 | 恢复配置与原tool owner；旧active snapshot不能直接当正确回滚。 |
| 结果被截断、替换、变成error | native工具输出边界；MCP guard/error hook；Web stored retrieval；SoL packing；未来reducer。 | 原始fake result、post-tool_result、message_end history、context投影、final请求分别的长度/错误位。 | 在不同阶段放相同marker；只关packing，看history是否原本未改；另测其他tool的call_failed详情。 | 恢复功能；不要删archive/response store来“修复”可召回性。 |
| 停止后又继续 | host queues/retry；Web后台/curator；SoL compact；workflow。 | 每条continuation的producer、triggerTurn/deliverAs、abort原因、barrier状态和run ID。 | 先无背景回调fixture，再只加Web；然后SoL online；最后workflow组合。预期新增run必须有生产记录。 | 恢复flag与同一fixture；业务目标pending不能因停跟踪变completed。 |
| UI闪烁或working信息消失 | 真正working writers；CC private renderer；editor wrapper；host重建。 | setter target+owner+generation计数，不记录显示正文；配置false是否已生效。 | 先验CC working确实未注册，再禁CC render；footer单测，不先禁所有observer。 | fresh process恢复单一writer；prototype恢复不能仅靠UI模式off猜测。 |
| compaction后遗失证据 | host summary边界；SoL packing/online；workflow恢复投影；archive缺失。 | canonical entry、summary保留范围、receipt/observation ID、archive可读性、最终canary。 | packing-only与actual-compaction分开；检验“数据仍在但未投影”与“源数据/身份已无效”。 | 从disposable session回滚；真实session不默认删除summary或人工改ledger。 |
| 切session后状态错误 | branch-local fast/plan/workflow；SoL plan/archive；webstore；observer UI。 | opaque session/branch/generation、恢复entry类型、无跨owner回写证据。 | 两个session放不同canary，tree/resume/reload；在切换后释放旧deferred callback。 | 回原session核对；丢弃旧ctx，重建进程；保留旧证据。 |
| 等待异常、通知异常 | MCP初始化；Bark await；tool内部网络/子进程；Web人工curator；SoL compact。 | 单调时钟phase spans、spawn/网络类别计数、timeout/exit状态；不取摘要正文。 | fake delayed hook/manager；Bark和Herdr分开隔离，不能向真实接收端发测试。 | 恢复入口后freshprocess；明确停止未来发送不撤回既有外发。 |

观察器也有成本：Bark await 可以处于 before-start 或 settlement 等待中，MCP input gate 可以在模型尚未请求前消耗时间；work-timing 与 provider内部 compute 不共享时钟语义。先把这些等待归到本地阶段，再分析推理时间。[M1] · [O12]（Bark 为委托书第105行 L-source）

---

## 5. 规则归属：内容所有权、注入机制与执行保证

### 5.1 各承载方式的工程取舍

| 方式 | 发现/注入与作用域 | 上下文/cache成本 | 约束力度与逃逸 | 调试、耦合与停用退化 | 本次推荐 |
|---|---|---|---|---|---|
| Portable Skill | catalog通常持续可见，正文按需/显式加载；任务方法作用域。 | 减少无需方法时的正文；加载时形成任务上下文。 | 语义指导，模型可漏读/误用；不是程序guard。 | 宿主发现/同名规则仍要adapter；停用失去方法不应失去底线。 | R3–R5、R8主体保留。 |
| 全局 `AGENTS.md` 等 | 宿主在启动/资源构造时实际读正文；个人持续偏好。 | 稳定短前缀比动态重复追加容易分析；具体cache收益须测。 | 提醒，不能强制执行；仍可能被后续prompt改写影响。 | 可检查加载清单/marker；项目规则保持另层；停用有明确默认退化。 | R1/R2与R7核心、R10底线首选。 |
| `APPEND_SYSTEM.md` / CLI append | Pi特有注入；文件选择与显式参数不是同一契约。 | 静态短适配可稳定；动态生成会改变prefix。 | 仍是自然语言，无额外强制力。 | 固定版本项目文件替代全局选项；对路径/覆盖更敏感。 | 留给Pi工具/角色薄适配，不优先放通用偏好。 |
| `SYSTEM.md` /完整替换 | 替换生成base；不是“多加几条规则”。 | 可能删除原生指引而非真正优化；需自己追版本。 | 仍不能强制执行。 | 本版本仍拼接context/append/skill等，但生成工具指引与默认规则可能丢失。 | 不为rg/fd采用。 |
| tool description/snippet/guidelines | 绑定实际active tool与schema；能力相邻。 | 每轮工具定义成本；增大schema不是免费；相同字符串可去重不等于语义去重。 | 说明能力；execute可保证工具内部窄契约，不能管所有外部路径。 | toolowner清晰时易测；宿主版本/tool形状耦合。 | 精确工具参数/输出、可观测复合操作的语义。 |
| extension确定性实现 | 由代码、模式、事件与输入条件激活。 | 可能省往返，也可能新增工具/prompt/entries/compaction调用。 | 在其拥有路径内可强制；会误拦、被内部/外部路径绕过。 | 需生命周期、取消、状态与升级测试；停用后需有语义退化。 | 复用现有subagents/workflow机械层；新功能需额外可测收益。 |
| 单一共享源+薄adapter | 内容唯一；宿主入口负责真正读取，而非“请再读”。 | 内容总量不必增加；避免双重投影。 | 内容一致不等于宿主权限/模型遵循等效。 | 多一层分发核验；可以用symlink或现有构建，不必新服务。 | 多agent路线优先。 |

Pi loading/prompt依据 [H1] · [H1c] · [H4] · [H11]；当前 authored/generation contract依据 [K1] · [K3] · [K4] · [K6]。以上成本与推荐属于工程判断，**没有模型A/B就不把“更可靠、更省token”写成已测事实**。

### 5.2 R1–R10 逐条归属矩阵

路径均相对于 `agent-skills` authored truth，除非标明 own extension。下表中的“当前加载”区分正文与description；未提供全局AGENTS正文的地方保留未知，不伪称已经完成重复文本审计。

| ID | 当前 owner/path与实际加载 | 建议owner与明确决策 | 必要Pi适配 | Codex/Claude等退化或适配 | 理由与验证 |
|---|---|---|---|---|---|
| **R1** rg/fd及fallback | `src/skills/disciplines/tool-decision-tree/SKILL.md`；routine搜索明确不触发其正文；全局是否已重复未知。[K1] | **拆分**：短偏好归持续共享源；复杂选择仍在Skill。Pi-only直接现有全局AGENTS。 | 无新extension；承认native grep/find默认已用rg/fd；bash-only补fd优先。 | 在各自真实全局入口投影同一正文；原生搜索工具按任务能力优先。 | 全局fixture中Skill未读仍应含R1 marker；toolset变动不造成“找不到bash而卡住”。 |
| **R2** 不仪式性command-v | 同一Skill正文；普通搜索未加载。[K1] | **拆分**到持续偏好，保留新环境/远端/CI的明确例外。 | 不删除worker-tools内程序化requireExisting检查；那是防下载/执行前条件，不是模型多余仪式。[O8] | 无探测服务；只有已知能力失效或新执行面才做有限验证。 | 缺工具时一次失败后合理fallback，不把exit1无匹配当未安装；正常输入不先跑探测。 |
| **R3** rg语义、PCRE2、ignore/hidden、平台与边界 | tool-decision-tree及其references；复杂检索按需；native schema另有语义。[K1] · [H8] · [H9] | **保留**按需知识；工具自身边界放description/docs。 | native参数不足时允许bash/专用解析；不要改写任意shell。 | 宿主native search能力不一致可接受；必须保持请求的检索语义。 | fixture覆盖no-match、lookaround、hidden/ignored、glob vs regex与截断；不要求固定同一命令串。 |
| **R4** COUNT/PREVIEW/EXECUTE | tool-decision-tree中的广域影响判断；不是普通小操作强制流程。[K1] | **保留语义方法**；特定bulk工具可以内建preview/execute两段。 | 仅在输入/目标集合/授权token可定义时机械化；不新增全局“三步状态机”。 | 各host可采用不同执行接口，但应同样识别广域风险与已授权scope。 | 小范围精确修改不被强迫ritual；广域fixture能产生可审阅的目标集合，实际执行与其绑定。 |
| **R5** JSON/YAML/AST、引号、scratch script | tool-decision-tree、`references/adhoc-command-composition.md`；shell-guidelines针对非平凡shell。[K1] · [K2] · [K5] | **保留并去重交叉表述**：选择方法归discipline，shell脚本实现归shell overlay，语言语义归language。 | 仅把已有专用结构化tool的schema/输出契约放工具层；不“一律jq/python/工具X”。 | 保留portable选择依据；各环境工具可用性不同。 | 特殊字符/多层引用fixture、可读脚本、syntax check与owned cleanup；不因机械迁移降低可审查性。 |
| **R6** 破坏性/提交发布授权 | tool-decision-tree动作边界、`workflows/implement-change/SKILL.md`的authority条件；全局底线来自L-source。[K1] · [K8] | **分层保留**：持续授权底线+任务具体scope+真实执行环境权限。security-guardrails是风险控制方法，不应替代授权owner。[K7] | 对已知工具参数可block；candidate/apply验证限定owned路径；不可从task状态自行授予发布权限。 | host hook权限结果/API不同；OS、远端账号/服务授权必须独立落实。 | fake拒绝与throw均阻断；fusion/MCP/exec绕行单独测；工具成功不能推出权限已获或业务完成。 |
| **R7** 语言/简洁/少可选commentary | `session/use-coding-skills/references/preference-contract.md`、`session/output-styles/SKILL.md`；全局含用户偏好但正文未知。[K3p] · [K4] | **拆分/条件删重**：稳定底线持续注入；特殊review/explanatory等输出模式按需。 | 通常不需prompt extension；不得多个hook每轮重复追加。 | Claude全局CLAUDE、Codex全局AGENTS投影同一偏好；当前用户要求优先。 | 全局marker计数=1；有格式任务时不误套极简；未核到具体重复句前不删正文。 |
| **R8** 直接Skill绕router、条件review、父验收 | `session/use-coding-skills/SKILL.md`及`workflows/implement-change/SKILL.md`。[K3] · [K8] | **保留portable semantic owner**。router是恢复/路由帮助，不变成mandatory gateway。 | toolguidelines只讲当前工具契约；review/apply事实由现有工具记录，验收仍由parent解释。 | 缺Pi工具时正常完成调查/验证/条件review，不伪造Pi bookkeeping。 | 直接匹配Skill能推进；小任务不被强制设计/review；apply成功仍不能自动close所有义务。 |
| **R9** 有界委派、证据绑定、continuation | implement-change的host completion contract方法；own `subagents`、`workflow`实现机械层。[K8] · [O5] · [O15] · [O16] · [O17] | **保持已分开的边界**：语义义务/验收归Skill与parent；record identity/revision/lease关联归现有extension。 | 不新增另一个scheduler；先补fusion/嵌套操作的观测解释与现有barrier测试。 | 其他host无等效ledger时使用项目记录和明确剩余事项；不声称相同自动续跑。 | interrupted不自动apply/discard；变更意图先reconcile；不同run的证据不能串接成完成。 |
| **R10** compaction恢复、资源归属清理 | use-coding-skills恢复约定、scratch reference、shell overlay；全局底线；own child/observer/workflow机制。[K2] · [K3] · [K5] · [O6] · [O8] · [O13] · [O16] | **分层拆分**：恢复先验证工具/指导/任务状态的短原则持续可见；host重放/owned资源清理由程序负责；任务恢复方法按需。 | session/branch generation、abort/dispose、可恢复entry；不让model负责猜内部id，也不默认GC全部历史。 | 各host按本地资源/会话语义验证等效结果；不要求同样entry格式。 | compact/tree/resume后canary仍在；旧callback不写新session；只清owned临时物，保留用户/registry证据。 |

`contracts/skills.toml` 是发布/元数据所有权的一部分，不是 Pi 内核执行的调度合同。`baseline` 等仓库术语不能直接翻译成“Pi 每轮加载完整 Skill 正文”。重点编辑源仍是 `src/skills/`；`skills/` 只应由既有生成方式更新。[K6] · [K9] · [H11]

### 5.3 `rg` / `fd` 端到端 worked example

**共享偏好正文建议（单段，未实施）：**

> 常规本地文本搜索优先 `rg`，文件发现优先 `fd`；能满足任务语义的宿主原生搜索工具同样合适。不要每次搜索前先做安装探测。工具确实不可用时采用明确 fallback；`rg` 无匹配不是缺工具。用户明确指定、远端或 CI 能力不同，以及 PCRE2、hidden/ignore、输出边界需要特殊处理时，以请求语义为准。

这段只表达R1/R2和例外入口，不把完整rg教程、授权流程、结构化数据方法一起持续注入。

**Pi-only 承载建议。** 在现有 `~/.pi/agent/AGENTS.md` 的偏好区保留这一段；先本地确认有没有等义正文，已有则不重复加入。`tool-decision-tree` 保留复杂分支，并删除已迁出的重复短规则或改为不重复正文的说明。不要为了读取这一段新增 before_agent_start extension；不要以两条偏好为由完全替换 SYSTEM。只使用Pi时也不必先建立一个共享偏好生成器。[H1] · [H4] · [K1]

**多agent承载建议。** 可以在现有仓库增加独立于Skill正文的 authored偏好片段，例如 `preferences/coding-defaults.md`（这是候选新路径，不是声称已有）。Pi和Codex的全局AGENTS由现有分发流程装配该正文；Claude的全局CLAUDE可以使用官方 `@` import实际加载同一部署片段，或者同样装配。只有当整份全局文件内容完全相同、不需要保留宿主特有正文时，才适合直接symlink整文件。不能把“请阅读路径X”当成确定注入。[D1] · [D4]

承载示意，不是执行指令：

| 位置 | 内容owner | 宿主实际读取的内容 |
|---|---|---|
| repo `preferences/coding-defaults.md` | 唯一共享偏好正文。 | 不依赖模型主动发现此文件。 |
| `~/.pi/agent/AGENTS.md` | shared fragment投影 + Pi/本机薄适配。 | 直接包含共享正文；不是一句懒加载引用。 |
| `$CODEX_HOME/AGENTS.md` | shared fragment投影 + Codex薄适配。 | 同上；先检查是否被AGENTS.override遮蔽及总量限制。 |
| `~/.claude/CLAUDE.md` | Claude薄适配及官方支持的共享import，或已装配正文。 | import须真实解析且符合信任/路径条件；不假定Claude自动读AGENTS。 |
| `src/skills/disciplines/tool-decision-tree/` | 复杂方法唯一源。 | 通过各host自己的Skill机制按需加载，不在adapter复制全文。 |

实际场景及预期结果：

| 场景 | 正确行为 | 能证明什么/不能证明什么 |
|---|---|---|
| 普通搜索，Skill正文未加载 | 全局偏好仍在system/context装配输入里。 | marker证明注入；不证明模型必然选rg。 |
| Pi默认bash-only工具面 | 允许bash执行rg/fd；host已有rg提示，新增重点是fd优先与无ritual。 | exact-string去重不会把所有等义句合并；不为省几个词重写host prompt。 |
| Pi启用native grep/find | 使用它们是符合偏好，不强制回到bash；native find输入是glob，不能当fd默认regex。 | 默认本地实现分别rg/fd；remote custom operations可能不是，不能从名称猜实际执行器。[H8] · [H9] |
| MCP/自定义搜索 | 依据索引新鲜度、范围、ignore语义、完整性和输出边界判断是否适用。 | 这属于任务语义；只有工具契约可核实后才视作等效，不一律排序CLI优先。 |
| managed explorer/reviewer child | 可能只有read/grep/find/ls；不要请求不存在的bash。 | child无Skills不等于无全局context；必须验证其实际agentDir、cwd和装配marker。[O6] · [O7] |
| managed worker child | role工具包含bash，程序先验搜索工具存在以避免自动下载安装。 | 不违反“模型不做仪式性command-v”；这是两个不同owner的检查。[O8] |
| `fd`确实不可用 | CLI可一次失败后改用任务等效的find或已有原生能力；不自动获得安装授权。 | 不在PATH也可能在Pi工具缓存；不能只凭PATH缺失宣称native find不可用。 |
| `rg`返回无匹配 | 保留无匹配结论；exit1不触发“换grep再搜一遍”的固定流程。 | 需要区分命令不存在、regex错误、真正无匹配；保持pipe/exit语义。 |
| 用户指定grep/find、PCRE2或ignore规则 | 尊重指定；native schema不足时选择可表达正确语义的路径；必要时加载R3方法。 | 偏好不是静默替换用户命令的授权。 |

三种强度的差别：

| 强度 | 程序保证的范围 | 主要代价/失败模式 | 结论 |
|---|---|---|---|
| 自然语言偏好 | 只保证正文被正确注入时模型有机会遵循。 | 漏遵循、上下文冲突；但低耦合、例外表达自然。 | 当前首选。 |
| 专门search工具 | 该tool调用内部的参数验证、路径范围、输出标记、明确fallback/错误分类。 | 维护跨平台/取消/分页/ignore契约；可能已有native工具足够。 | 只有重复问题与清晰输入输出已成立时评估。 |
| 拦截/改写任意bash | 很难在任意shell语义下安全保证等效。 | quoting、subshell、变量、别名、脚本、远端执行、BSD/GNU差异与工具内部I/O；可绕过也可误改。 | 不推荐静默grep/find→rg/fd重写。已知不可接受行为宜明确拒绝并说明，不擅自改义。 |

优化目标应是减少可复核的错误/冗余调用、保持正确例外与降低维护负担，不是提高“Pi-native含量”。当前没有数据支持为了R1/R2新增搜索wrapper或bash拦截器。


## 6. 两种路线、跨 agent 一致性与可逆候选 backlog

### 6.1 Pi-only 与 portable core 的条件化选择

| 决策面 | Pi-only 优化 | Portable core + thin adapters |
|---|---|---|
| 何时合理 | 其他agent已不提供值得维护的独立能力；主要工作和恢复都发生在Pi。 | Codex/Claude等仍用于独立实现、复审、不同工具面或可用性退路。 |
| 内容owner | 复杂方法仍可留现有Skills；持续偏好可直接Pi全局AGENTS。 | 方法仍在authored Skills；持续偏好另有唯一源；host入口只是运输和局部说明。 |
| 工具适配 | 更积极使用Pi native工具提示、现有managed sessions与goal contract。 | 核心方法不引用Pi工具名；Pi adapter说明具体名字/records，其他host按原生能力退化。 |
| 硬约束 | 在Pi-owned调用路径内实现明确可测的mechanical invariant。 | 不强求三套hook代码一致；以外部授权/执行边界和结果oracle保持必要等效。 |
| 主要维护成本 | 跟踪Pi版本、private TUI patch、动态tool ownership、session/abort契约。 | 多维护发现与权限差异；但不复制方法全文，不为各host重建一套workflow。 |
| 不该迁移的内容 | 目标边界、复杂搜索判断、授权语义、条件review、业务验收。 | 同左；它们恰是portable价值，而不是兼容包袱。 |
| 停用退化 | 没有extension时仍有偏好和任务方法；自动ledger/continuation功能消失需明示。 | 其他host缺Pi机制时仍可完成任务，但不能声称同样自动恢复/同样状态机。 |

**当前建议选择portable core + thin adapters，但不为了“跨agent完整等效”保留无用兼容层。** 这不是因为迁移Pi必然不好，而是R1–R5大多没有需要宿主强集成才能获得的额外收益；现有R8/R9已经提供合理的能力条件分支。真正值得Pi-native的是已经存在的工具身份、候选管理、ledger关联、branch恢复和barrier，而不是把同样的自然语言换成TypeScript字符串。[K1] · [K3] · [K8] · [O5] · [O16]

当其他agent长期只承担极少且可完全由Pi替代的工作，而每次方法修改都必须为其写复杂适配、debug发现或重建权限语义时，兼容成本可能超过价值。反过来，只需一个小全局入口与Skill发现symlink就能保留独立复审/实现能力时，删除portable core的收益很弱。需要用真实使用任务、恢复价值和维护记录判断，不用抽象“兼容率”评分。

### 6.2 官方支持差异，不能抹平

下表的Codex/Claude依据**2026-09-18访问的官方文档**；用户本地CLI版本未提供，所以不是安装版本核验。Pi严格限定0.85.1。[D1] · [D2] · [D3] · [D4] · [D5] · [D6]

| 维度 | Pi 0.85.1 | Codex CLI，文档访问日 | Claude Code，文档访问日 |
|---|---|---|---|
| 全局持续指令 | agentDir的AGENTS及fallback机制。 | `$CODEX_HOME` 默认`~/.codex`；AGENTS.override优先于AGENTS。 | `~/.claude/CLAUDE.md`；不自动读AGENTS。 |
| 项目发现 | 上层context文件与项目资源发现；每目录候选优先序，另有worktree去重处理。 | repo root到cwd；每目录一个候选；总量默认32KiB，越近目录内容越后。 | 上级CLAUDE启动加载，子目录可在读取相关文件时按需加载；支持规则分层。 |
| 普通共享文件import | 不把任意`@file`或“请阅读”当成全局指令import。 | 不假定支持Claude同款AGENTS内`@`导入；用真实正文或已验证构建。 | 官方`@path` import能实际载入内容；路径/信任条件需核对。 |
| Skills位置 | Pi目录及`~/.agents/skills`等；明确加载/信任条件。[H11] | 官方支持`~/.agents/skills`及repo内`.agents/skills`，支持symlink。 | personal/project `.claude/skills`、plugin等；应显式适配当前`.agents`发布布局。 |
| 同名/重复发现 | 不能假定全部merge；同名选择按Pi发现规则。 | 同名Skill不合并，可能同时出现在selector。 | 有作用域优先级与plugin命名空间；相同symlink目标可去重。 |
| hooks/工具权限 | 同进程extension API、tool preflight、任意Node能力。 | 官方已有PreToolUse/PostToolUse等；hosted tools与部分持续session操作有覆盖缺口。 | 官方hooks与permission decisions；`@`文件引用不等于一个Read工具调用。 |
| metadata可移植性 | 不能把Skill frontmatter字段当成统一执行权限。 | `agents/openai.yaml`等是宿主专属选择/调用元数据。 | `allowed-tools`等可改变该host的审批行为；不当通用文档字段复制。 |
| 子代理/续跑 | 本组合自定义managed native sessions与v2 ledger。 | 使用其本地机制；没有证据表明与Pi同款记录/barrier语义。 | 同左；不得用名称相似推导相同生命周期。 |

Codex当前文档的工具hook支持范围与decision输出并不等同于Claude。迁移时要逐条验证matcher、blocking、updatedInput、错误时行为和hosted/nested操作覆盖；不能把一份hook JSON或脚本复制到三家后宣称执行保证一致。[D3] · [D6]

### 6.3 唯一内容源与运输层

**复用同一仓库，不强迫复用同一个Skill正文。** 现有 `src/skills/ → skills/` 布局继续负责portable方法；持续偏好可以作为仓库内独立authored片段，或由现有dotfiles源负责。关键是确定一个owner，而非同时在preference-contract、全局AGENTS、APPEND_SYSTEM和extension字符串各维护一份。[K3] · [K6]

| 分发方法 | 何时成立 | 主要失败模式 | 维护/回滚 |
|---|---|---|---|
| 整文件symlink | 宿主确实读取目标，整份内容可共用，不需要独立host正文。 | 覆盖已有全局偏好；多个alias重复发现；路径/平台权限。 | 单一owner、旧link可回退；不把symlink目标当可独立编辑副本。 |
| 官方实际import | 此host有明确解析语义，例如Claude CLAUDE中的`@`。 | 把其他host的相似语法误当相同能力；外部路径trust不满足。 | 检查loaded清单与canary；共享文件回退一处即可。 |
| 现有构建/分发装配 | 多个host需要各自薄正文，并且已有发布流程。 | generated文件被手改漂移；片段重复；无原子更新/旧版回滚。 | 生成结果标owner/revision，check差异；无需引入同步守护进程。 |
| 轻量复制 | 极少宿主、更新稀少且可由同一命令确定生成。 | 一旦独立手工修改就失去唯一truth。 | 将复制视为build输出，验证hash与内容片段计数；不用手工追改。 |
| 仅正文写“请读共享文件” | 适合按需资料入口。 | 模型未读时持续偏好根本未注入。 | 不作为R1/R2可靠承载方案。 |

需要严格等效的是**授权范围、保留用户修改、不得虚构证据、业务验收由适当owner负责**。`rg`而非原生grep、输出简洁程度、具体搜索调用次数属于偏好/性能目标。Pi的record IDs、候选apply、自动续跑、overlay属于可接受的native enhancement；其他host没有它们时必须有明确的功能退化，而不是假装等效。

避免重复的方法不是让另一个extension扫描并删prompt，而是在装配层给规则明确owner，只投影一次；Skill保留例外与方法，不复制持续短段。对压缩后的验证应同时检查重新构造的全局指导、当前工具能力与任务ledger，不通过追加更多“记住之前规则”来掩盖失效。[H4] · [K3] · [O16]

### 6.4 分阶段候选 backlog：不是实施授权

规则迁移内部，“先删重/补持续偏好，再薄适配，最后专用工具或拦截器”的顺序合理。**但当前已有的fusion执行面和tool ownership值得先核对，不能以偏好整理代替运行边界诊断。**

| 阶段/候选 | 收益与成本 | 源文件owner | 所需权限 | 验证gate | 退回原状 |
|---|---|---|---|---|---|
| B0 版本/工具回执 | 把已安装与实际owner分开；只增加少量脱敏诊断。 | 本地测试fixture/报告，不先改稳定架构文档。 | 只读版本/资源清单；允许创建disposable测试目录。 | after-session_start与延迟注册完成后的owner/schema；npm制品一致性。 | 删除disposable输出；用户配置不变。 |
| B1 CC/SoL write所有权决策 | 消除意外mask；代价是可能放弃某项diff或fusion能力。 | 第三方有效配置；若修代码需单独owner/升级方案。 | 定向配置变更或独立源码修改授权。 | 双向order+schema+execute fake oracle；不能仅看UI外观。 | 保存原feature配置/revision，freshprocess恢复。 |
| B2 R1/R2/R7持续偏好拆分 | 普通任务不依赖Skill正文，删去可证重复；成本为一次owner整理。 | `src/skills/...`与唯一偏好源；host入口是generated/adapter。 | 修改authored及全局指令的明确许可。 | 无Skill时marker存在一次；用户要求覆盖例外；三host加载核验。 | 回退同一authored revision并再分发，禁止反向手改generated。 |
| B3 child偏好与capability核验 | 防止父级适配只在parent生效；无需新调度器。 | child runner/role guidance与测试fixture。 | 先离线观察；需要改runner时另行授权。 | noSkills/noExtensions下global canary与允许toolset正确。 | 还原role/runner revision；不改managed历史。 |
| B4 continuation/barrier组合测试 | 明确intentional abort、webcallback、pending goal的归属；成本是少量状态fixture。 | 现有workflow settlement及SoL/Web接缝测试。 | 离线fake-Pi；真实provider/网络另批。 | 无无来源run；无旧lease续跑；suspend原因可解释；不丢pending业务义务。 | 退回fixture/flag；没有批准前不加scheduler或auto-accept。 |
| B5 两项悬空指导清理 | 条件成立时减少无效Skill/工具查找。 | MCP Skill选择或工具description；CC agent-mention feature。 | 仅针对已证明不适用的入口修改。 | mcp-scripting实际发现；Agent工具owner与匹配agents存在性。 | 恢复原选择；不批量禁用不相关功能。 |
| B6 专用search工具试验 | 仅当native工具不能解决反复发生的参数/范围问题时有额外收益。 | 独立小tool及schema/执行器测试，不改portable方法owner。 | 新工具部署授权；默认无外部副作用。 | 与native/bash基线比错误/额外调用，取消与语义fixture均过。 | 排除该入口；保留自然语言偏好与native退路。 |
| B7 发布稳定行为地图 | 把验证后的地图变成可维护truth；需要持续版本标注。 | 候选 `docs/architecture/pi-extension-integration.md`。 | 本地复核后文档变更授权。 | 所有“当前激活”都有本地回执；未知仍标未知。 | revert该文档revision；本报告仍作为研究输入而非替代truth。 |

---

## 7. 最小本地验证矩阵、开放问题与推翻条件

### 7.1 先分清两类实验

**结构确定性测试**验证加载、注册、阶段转换、事件/记录身份、取消、队列、恢复和清理；优先fake stream/fake tools、disposable settings/session，禁止意外下载native工具或启动真实MCP/provider。已有源码直接证明的first-wins、APPEND文件选择等无需反复跑模型来“验证”。

**模型遵循实验**才回答R1/R2是否减少冗余调用、错误率和wall time是否改善、压缩后语义判断是否更好。需要用户另行授权真实调用范围，固定模型/版本、输入、工具面、方法源和配置，记录遵循结果。没有这类实验，不宣布token节省、cache收益或百分比可靠性。

### 7.2 最小结构验证矩阵

| 测试 | 固定fixture与变量 | 预期oracle | 不可接受的替代证据 |
|---|---|---|---|
| T01 资源确实加载 | 无extensions/单个/组合；记录显式CLI和项目覆盖标识。 | factory成功、session_start成功、最终toolowner/schema分开；目标feature确实注册。 | package在磁盘；配置中列了名字。 |
| T02 CC/SoL所有权 | 两个顺序；只开启write相关最小路径；在打印/JSON模式亦检查。 | CC先时write来自CC且无fusion schema；SoL先时owner为SoL且CC不夺取。 | 在factory之后、session_start之前截一份tool表。 |
| T03 动态注册/异常 | 同名tool在factory/session_start/延迟任务注册；handler throw。 | 确认first-wins、refresh和错误记录；SoL配置失败不误报activated。 | 将普通hook异常与tool_call异常视作同一种fail-open。 |
| T04 input来源 | native文本、`$skill`、`@session`、extension用户消息、custom-trigger分别输入。 | 实际user/custom message与context marker、prepared来源关联正确；handled不继续误提交。 | 用一次early input snapshot代替最终消息。 |
| T05 final请求 | 每个阶段加入不同无敏感canary；所有provider调用替换为fake边界。 | 最后transport适配收到的system/messages/tools/payload字段包含预期marker且只一次。 | 把CC `/context`统计或较早provider hook当wire oracle。 |
| T06 sequential/parallel | fake tools可控制resolve顺序和executionMode。 | start/end/after-result轨迹符合host；证据按toolCallId关联而非完成时间猜测。 | 单看返回数组顺序。 |
| T07 fused执行 | 用可注入fake文件/bash执行器，不调用真实shell。 | edit/write外层事件存在；inner bash没有第二条顶层事件；命令失败时文件mutation已发生。 | 自行补发假的host tool events，然后声称原生已覆盖。 |
| T08 MCP nested | fake manager/approval handler/worker通信；禁止真实server连接。 | 外层Pi事件与每个内层operation/approval记录分开；timeout后状态可解释。 | 只有mcpScript顶层成功，就认定全部内部调用成功/均获批。 |
| T09 tool结果层次 | 超限纯文本、无匹配、details.error命中、非文本结果。 | raw/post-hook/history/context/final差异各有归属；MCP跨包同码可复现或排除。 | 将“UI折叠了”当结果截断；将archive existence当所有原文仍发送。 |
| T10 compaction与barrier | fixture plan完成、fake经济判断/compact、pending goal；插入web deferred callback。 | 每个新增run都有producer；intentional abort与workflow lease失效可解释；无误验收。 | 只观察agent_end数量或表面闲置。 |
| T11 tree/resume/abort | 两条branch、两个session、旧callback延后resolve。 | identity/generation匹配；旧ctx拒绝；新session不收到旧owner消息；pending状态不自动消失。 | 从一个成功正常退出推导所有恢复路径正确。 |
| T12 reload与停用 | F/E后分别reload与freshprocess；不删除历史。 | 未来工具/UIwriter关闭；旧entry保留；prototype/timer/子进程残留单独核查。 | `/ccstyle off`后外观变了，就认定write override撤销。 |
| T13 TUI/RPC/print/SDK | 固定mode/hasUI及memory/file-backed session组合。 | TUI组件只在合适mode；RPC交互按协议；headless仍可改tool/prompt；无sessionDir功能合理退化。 | hasUI=true等价tui；headless等价无extension。 |
| T14 managed child | 只解析runner参数与使用fake native session/stream，不启动真实模型。 | 指定guard加载、Skills关闭、role工具正确、共享偏好canary是否实际装配。 | parent tool清单或AGENTS存在证明child继承。 |
| T15 三host R1–R3注入 | 每host实际支持版本、fixture instructions与一个复杂Skill。 | 来源/重复计数/作用域正确；routine不需要读Skill仍有R1/R2；R3例外可载入。 | 模型自述“我遵循了全部规则”，没有加载证据。 |

T02、T07、T10应优先；这是当前最可能改变工具行为、观测结论和continuation判断的三个fixture。T15的模型服从部分另行执行，不混入这份结构测试。

### 7.3 只需要最少脱敏字段

建议本地生成白名单回执：host版本与发布hash、extension稳定ID及resolved顺序、factory/session_start状态、effective config来源类别（global/project/CLI）及相关布尔值、mode/hasUI、tool name/owner/schema hash、active names、phase序号、opaque session/branch/generation/run/call ID、消息source/role/customType、canary存在次数、长度/错误位、continuation producer、单调时钟span、清理结果。

**不需要外发**完整settings、provider/model选择、路由、凭据、绝对私有路径、会话正文、通知摘要或system prompt。prompt核验优先纯fixture；真实环境只输出本地计算的白名单marker和计数。若使用摘要指纹，不把它当匿名化全部敏感内容的保证，也不从hash反推正文。

本地验证者负责抓取真正最终装配边界，不让每个extension自行宣布“我的prompt正确”来代替端到端结果。测试代码也不得为了观测而意外调用真实provider、MCP认证、Herdr socket或Bark hook。

### 7.4 开放问题、最小补证与推翻推荐的条件

| 未知 | 最少所需证据 | 什么结果会改变本报告判断 |
|---|---|---|
| npm部署制品与release源码是否一致 | 三个固定版本的公开tarball及integrity，或本地选定相关文件hash与release比对；RPIV只需manifest/入口版本锚点。 | tarball相关实现不同，需重做对应P-source映射；不能继续声称部署版本具备同一行为。 |
| CC/SoL是否实际争write | after-session_start的owner/schema、resolved order、有效SoL flag。 | SoL未激活、CC不在同进程或有第三owner，则当前命中结论撤回，保留机制分析。 |
| CC @agent是否适用 | 是否存在可匹配agent定义的布尔值；`Agent` tool存在与owner；脱敏fixture名字。 | 确有适配的Agent工具则不应建议关此feature；完全无定义则不是当前注入来源。 |
| MCP Skill提示是否悬空 | `mcp-scripting`实际Skill发现清单布尔值、来源类别。 | 另有同名Skill正确加载，就不需补入口；仍须检查重复发现。 |
| SoL配置最终值/初始化 | 来源类别、四个flag、session_start成功/错误。 | 项目配置覆盖或解析失败，则不能按全局true推定功能已激活。 |
| workflow与SoL是否需修代码 | fake trace显示abort、lease、compact、queuedrun、goal/suspend reason。 | 组合已稳定保留预期义务且没有错误suspend，则只需文档化，无需修改；若确定死等再单独设计修复。 |
| 全局短偏好是否已有 | 本地按R1/R2/R7 rule ID输出“存在/重复/冲突”的小回执，不给完整正文。 | 已持续注入且无重复则保持不动，不执行形式性迁移。 |
| child是否继承持续偏好 | child实际context装配的canary/来源类别；agentDir/cwd只需脱敏关系。 | 自定义loader/参数抑制全局context时需薄child adapter；不能继续依赖parent全局文件。 |
| packing/compaction是否影响验收 | 固定证据fixture的原始entry、projection与恢复结果；模型实验另批。 | 身份或必须证据不可恢复，则需改变feature范围/投影；只有UI不可见不构成同一故障。 |
| 通知/状态上报真实副作用 | 本地程序可用性、权限、发送目标类别、timeout/exit与计数；不发测试通知。 | 实际未加载/环境条件不满足就不是延迟来源；接收端保留/路由策略另作明确审查。 |
| 跨agent适配收益是否值得 | 真实任务角色、采用频率、独立复审/恢复价值与维护变更记录。 | 多agent几乎无独立价值且适配显著复杂，可转Pi-only；仅几条入口维护则保留portable更经济。 |

**最终决策边界：** 静态证据足以反对整包Skill扩展化、任意bash静默重写和“工具成功即语义完成”，也足以指出本版本CC/SoL的所有权依赖及fusion事件粒度。但当前进程加载、npm字节一致、组合恢复和模型效果仍须本地核验。后续可以据已验证部分更新稳定行为地图；不应把这份研究报告直接升级为当前架构或自动实施计划。

---

## 固定源码定位索引（第2节覆盖账本的展开）

下列为本报告实际核对的公开文件定位。长文件列出关键函数/行段；链接固定commit，不使用最新main。源码行号按GitHub一基编号；raw检索器的零基行号已相应换算。相关函数可在同一固定文件内继续核对，不把未展开的helper算成已完成安全审计。

| ID | 定位及重点 |
|---|---|
| [H1] / [H1c] | resource-loader：context候选/祖先范围65–148；project/trust加载约420–590；SYSTEM/APPEND选择949–975。 |
| [H2] / [H2t] | extensions/runner：context/mode412–466；工具first-wins471–492；commands/shortcuts独立策略；dispatch804–1210。 |
| H3 | package-manager：资源过滤空数组2067–2089；排除/包含pattern语义另见同文件。 |
| H4 | system-prompt：custom/default分支44–108；context/Skill等拼接。 |
| [H5] / [H5p] / [H5t] | agent-session：settled591–599、message持久化625–772；prompt/send/idle1034–1526；工具刷新2494–2581；reload2632–2656。 |
| H6 | extensions/loader：handler/tool注册265–280；factory510–528；顺序加载568–604。 |
| [H7] / [H7t] | agent-loop：loop145–272；批次顺序383–398；tool lookup/prepare/preflight与执行约580–650。 |
| H8 / H9 | grep.ts / find.ts：schema、默认rg/fd执行及输出边界；find默认本地分支159–200。 |
| H10 / H11 | 固定Pi extensions/skills文档；公共API、模式2619–2628；Skill发现与正文加载。 |
| O1–O3 | plan-mode、multi-skill-mentions、fast-gpt入口。 |
| O4–O9 | subagents入口、continuation、runner、roles、worker-tools、child-capability-guard；关键child参数在runner。 |
| O10–O13 | herdr-handoff、status-footer、work-timing、subagents-ui入口。 |
| O14–O18 | workflow入口、goal-tool、goal-host、settlement、shared/prepared-input。 |
| S1 / S2 | SoL主入口28–32的首次启动注册；config.ts默认值/项目选择/严格解析。 |
| S3 / S4 | action-fusion/index与then-run：覆盖schema、mutation后直接builtin bash.execute。 |
| S5 / S6 / S8 | observation-pack/index、observation、runtime-paths：投影、archive与sessionDir。 |
| S7 / S10 | online-context-compact/extension：turn_end239–289、settled290–391；tools.ts的update_plan。 |
| S9 | evidence-preserving-reducer/index：tool_result173–187；当前仅检查该介入边界。 |
| C1 / C15 | CC config默认96–121、加载/错误回退267–280；package.json peer范围。 |
| C2 / C3 | renderer/index191–208的write注册与TUI安装；diff/index80–109的external owner判断及wrapper。 |
| C4–C8 | working-message、markdown-enhance、compact-thinking、session reference、agent reference；input与UI不是同一表面。 |
| C9–C14 | agent-summary入口/core、context、aliases、startup-header、flush-docked-bash。 |
| M1 / M2 | MCP index：注册与初始化、输入gate、error hook、commands、mcpScript912起、mcp960起。 |
| M3 / M4 / M5 | mcp-code：128–145内层调用与236起Worker；proxy-modes：1147起approval及真正call；error-signal的无tool-name predicate。 |
| W1 / W2 / W2b | Web index：工具开关223–263，session1671–1685；后台sendMessage约1000–1070；curator follow-up约3030–3060。 |
| W3 / W4 | Web index：source_check2257–2351、fetch_content2352起、get_search_content2676起。 |
| K1–K9 | 重点authored Skill、scratch reference、preference contract、output-styles、shell、contracts、安全/实施边界及代表发布文件。 |
| D1–D6 | Codex/Claude官方指令、Skills、hooks文档，访问2026-09-18；非用户安装版本审计。 |


### 引用链接

以上源码ID通过下列固定链接解析；官方产品文档仅按本次访问日期定位。

**版本锚点：** [V1] · [V2] · [V3] · [V4] · [V5] · [V6] · [V7]

**Pi宿主：** [H1] · [H1c] · [H2] · [H2t] · [H3] · [H4] · [H5] · [H5p] · [H5t] · [H6] · [H7] · [H7t] · [H8] · [H9] · [H10] · [H11]

**自维护extensions：** [O1] · [O2] · [O3] · [O4] · [O5] · [O6] · [O7] · [O8] · [O9] · [O10] · [O11] · [O12] · [O13] · [O14] · [O15] · [O16] · [O17] · [O18]

**SoL：** [S1] · [S2] · [S3] · [S4] · [S5] · [S6] · [S7] · [S8] · [S9] · [S10]

**CC：** [C0] · [C1] · [C2] · [C3] · [C4] · [C5] · [C6] · [C7] · [C8] · [C9] · [C10] · [C11] · [C12] · [C13] · [C14] · [C15]

**MCP：** [M1] · [M2] · [M3] · [M4] · [M5]

**Web：** [W1] · [W2] · [W2b] · [W3] · [W4]

**Skills：** [K1] · [K2] · [K3] · [K3p] · [K4] · [K5] · [K6] · [K7] · [K8] · [K9]

**跨agent官方文档：** [D1] · [D2] · [D3] · [D4] · [D5] · [D6]


[V1]: https://github.com/earendil-works/pi/commit/d981de1229ef899957bbe968bc8dcda02a21f477
[V2]: https://github.com/CsHeng/pi-extensions/commit/f86a72dd985224dcbd415de00e14771c69552e63
[V3]: https://github.com/CsHeng/agent-skills/commit/e0d4a230fc70355181709b911ab4b546177b13b4
[V4]: https://github.com/nicobailon/pi-mcp-adapter/commit/eca6e8e14746f2a093e5d3085ccc244832962d71
[V5]: https://github.com/nicobailon/pi-web-access/commit/192ac1875e3b8f88c78953dbc314949ec9fcaa27
[V6]: https://github.com/minuque/pi-cc-extensions/commit/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11
[V7]: https://github.com/NVlabs/SoL-Pi/commit/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1
[H1]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/resource-loader.ts#L65-L148
[H1c]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/resource-loader.ts#L949-L975
[H2]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts#L804-L1211
[H2t]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts#L471-L492
[H3]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/package-manager.ts#L2067-L2089
[H4]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/system-prompt.ts#L44-L154
[H5]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L591-L800
[H5p]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L1034-L1526
[H5t]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L2494-L2656
[H6]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/loader.ts#L265-L604
[H7]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L145-L272
[H7t]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L383-L650
[H8]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/tools/grep.ts#L17-L173
[H9]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/tools/find.ts#L24-L201
[H10]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/extensions.md#L2615-L2628
[H11]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/skills.md#L1-L211
[O1]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/plan-mode/index.ts#L1-L177
[O2]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/multi-skill-mentions/index.ts#L1-L150
[O3]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/fast-gpt/index.ts#L1-L93
[O4]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/subagents/index.ts#L1-L52
[O5]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/subagents/continuation.ts#L1-L382
[O6]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/subagents/runner.ts#L1-L334
[O7]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/subagents/roles.ts#L1-L34
[O8]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/subagents/worker-tools.ts#L1-L268
[O9]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/subagents/child-capability-guard.ts#L1-L37
[O10]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/herdr-handoff/index.ts#L1-L108
[O11]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/status-footer/index.ts#L1-L429
[O12]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/work-timing/index.ts#L1-L611
[O13]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/subagents-ui/index.ts#L1-L278
[O14]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/workflow/index.ts
[O15]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/workflow/goal-tool.ts#L1-L49
[O16]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/workflow/goal-host.ts#L1-L103
[O17]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/workflow/settlement.ts#L1-L69
[O18]: https://github.com/CsHeng/pi-extensions/blob/f86a72dd985224dcbd415de00e14771c69552e63/extensions/shared/prepared-input.ts#L1-L70
[S1]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/index.ts#L11-L34
[S2]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/config.ts#L1-L126
[S3]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/action-fusion/index.ts#L1-L160
[S4]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/action-fusion/then-run.ts#L49-L119
[S5]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/observation-pack/index.ts#L1-L217
[S6]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/observation-pack/observation.ts#L1-L234
[S7]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/online-context-compact/extension.ts#L239-L391
[S8]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/runtime-paths.ts#L7-L16
[S9]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/evidence-preserving-reducer/index.ts#L170-L208
[S10]: https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/online-context-compact/tools.ts#L1-L96
[C0]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/index.ts#L1-L34
[C1]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/config/config.ts#L96-L280
[C2]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/renderer/index.ts#L176-L267
[C3]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/renderer/tool/diff/index.ts#L59-L110
[C4]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/shell/working-message.ts#L90-L202
[C5]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/renderer/markdown-enhance.ts#L174-L194
[C6]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/compact-thinking.ts#L1-L1078
[C7]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/reference/index.ts#L343-L509
[C8]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/reference/subagent.ts#L124-L183
[C9]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/agent-summary/index.ts#L1-L28
[C10]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/agent-summary/core.ts#L1-L152
[C11]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/context.ts#L1-L686
[C12]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/shell/aliases.ts#L1-L27
[C13]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/shell/startup-header.ts#L257-L285
[C14]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/extensions/feature/shell/flush-docked-bash.ts#L1-L35
[C15]: https://github.com/minuque/pi-cc-extensions/blob/e43e0041b59f5d7f03be9b9d103a5f9e954e4c11/package.json
[M1]: https://github.com/nicobailon/pi-mcp-adapter/blob/eca6e8e14746f2a093e5d3085ccc244832962d71/index.ts#L600-L1220
[M2]: https://github.com/nicobailon/pi-mcp-adapter/blob/eca6e8e14746f2a093e5d3085ccc244832962d71/index.ts#L210-L300
[M3]: https://github.com/nicobailon/pi-mcp-adapter/blob/eca6e8e14746f2a093e5d3085ccc244832962d71/mcp-code.ts#L99-L343
[M4]: https://github.com/nicobailon/pi-mcp-adapter/blob/eca6e8e14746f2a093e5d3085ccc244832962d71/proxy-modes.ts#L1147-L1332
[M5]: https://github.com/nicobailon/pi-mcp-adapter/blob/eca6e8e14746f2a093e5d3085ccc244832962d71/error-signal.ts#L1-L21
[W1]: https://github.com/nicobailon/pi-web-access/blob/192ac1875e3b8f88c78953dbc314949ec9fcaa27/index.ts#L1672-L1755
[W2]: https://github.com/nicobailon/pi-web-access/blob/192ac1875e3b8f88c78953dbc314949ec9fcaa27/index.ts#L980-L1075
[W2b]: https://github.com/nicobailon/pi-web-access/blob/192ac1875e3b8f88c78953dbc314949ec9fcaa27/index.ts#L3010-L3065
[W3]: https://github.com/nicobailon/pi-web-access/blob/192ac1875e3b8f88c78953dbc314949ec9fcaa27/index.ts#L2258-L2400
[W4]: https://github.com/nicobailon/pi-web-access/blob/192ac1875e3b8f88c78953dbc314949ec9fcaa27/index.ts#L2677-L2780
[K1]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/src/skills/disciplines/tool-decision-tree/SKILL.md#L1-L92
[K2]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/src/skills/disciplines/tool-decision-tree/references/adhoc-command-composition.md#L1-L38
[K3]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/src/skills/session/use-coding-skills/SKILL.md#L1-L48
[K3p]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/src/skills/session/use-coding-skills/references/preference-contract.md#L1-L31
[K4]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/src/skills/session/output-styles/SKILL.md#L1-L46
[K5]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/src/skills/policies/shell-guidelines/SKILL.md#L1-L137
[K6]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/contracts/skills.toml#L1-L326
[K7]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/src/skills/policies/security-guardrails/SKILL.md#L1-L105
[K8]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/src/skills/workflows/implement-change/SKILL.md#L1-L101
[K9]: https://github.com/CsHeng/agent-skills/blob/e0d4a230fc70355181709b911ab4b546177b13b4/skills/tool-decision-tree/SKILL.md#L1-L92
[D1]: https://developers.openai.com/codex/guides/agents-md
[D2]: https://developers.openai.com/codex/skills
[D3]: https://developers.openai.com/codex/hooks
[D4]: https://code.claude.com/docs/en/memory
[D5]: https://code.claude.com/docs/en/skills
[D6]: https://code.claude.com/docs/en/hooks
