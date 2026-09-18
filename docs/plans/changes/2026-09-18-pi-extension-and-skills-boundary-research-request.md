# Pi Extension 与 Skills 边界调研书

日期：2026-09-18。

状态：交给 GPT Pro 的外部研究请求；不是已完成的审计、当前架构或获批的迁移方案。本文的本地基线是一次只读盘点，不证明当前 Pi 进程实际加载了什么。

使用方式：可以将本文整体交给 GPT Pro。请依据固定版本源码完成下述研究，返回中文报告，保留 API、文件名和工具名的原文。不要实施改动；研究结果交回本地核验后，才决定是否形成设计或实现计划。

本文属于 `docs/plans/` 阶段材料，默认文档搜索不包含它。未来经验证的行为地图可以另行落入 `docs/architecture/pi-extension-integration.md`；本文不提前建立该稳定真相。

## 1. 研究目标

我维护一些 Pi extensions，也安装了第三方 extensions；同时维护一套可跨 coding agent 使用的 Skills。现在需要两份能够互相解释的地图，而不是插件功能介绍或一般性的“最佳实践”：

1. **Pi 行为介入地图**：Pi 原生怎么运行；当前这组 extensions 分别在哪个阶段、通过什么 hook/API/其他机制介入；改写了什么；哪些只是观察；出现异常时如何定位、隔离和恢复。
2. **规则归属地图**：现有 Skills 中哪些是可移植的语义方法，哪些是应持续生效的用户偏好，哪些是 Pi 特有的工具提示或可确定执行的机械约束。分别适合放在 Skill、全局/项目指令、system prompt 定制、工具定义还是 extension 的哪一层。

最终要支持实际的保留、禁用、拆分、迁移或删除决策。允许结论是“保持不动”“删去重复规则”或“Pi 原生已经满足”，不要默认新增 extension 才是优化。

### 必须正面回答的用户问题

- 如果以后只使用 Pi，原来放在 Skills 里的部分内容是否应转成 Pi 原生机制？为什么，收益和代价是什么？
- 以 `tool-decision-tree` 中偏好 `rg` / `fd` 的规则为例：应放在 `~/.pi/agent/AGENTS.md`、`APPEND_SYSTEM.md`、工具提示、extension，还是继续留在 Skill？不能只给抽象分层原则。
- 如果仍使用 Codex、Claude Code 等其他 agent，怎样保留同一套偏好而不手工维护多份相互漂移的正文？哪些宿主差异无法消除？
- 哪些规则适合提醒模型，哪些值得由程序保证，哪些根本无法由 Pi 的 extension 安全、完整地保证？
- 当前 extension 组合有什么重叠、顺序依赖或失效风险？哪些是真实源码问题，哪些只是待验证假设？

## 2. 本地基线与研究边界

### 2.1 证据分级

后文标注的本地事实由委托方读取本地文件或执行只读检查得到。外部研究者可以引用为“委托方基线”，但不得伪装成自己重现的结果。

- **L-config**：安装清单、版本或配置选择；不等于进程已加载，更不等于功能已触发。
- **L-source**：本地源码确认；不等于运行时行为已验证。
- **P-source**：研究者核对固定公开版本后的源码结论，应给 permalink 和关键行号。
- **R-observed**：实际运行观察，必须有版本、模式、触发条件和结果。本次盘点没有建立完整的 R-observed 组合证据。
- **Hypothesis / Unknown**：推断或未知；说明什么证据能证实或推翻。

严格区分 `installed`、`configured/selected`、`loaded`、`feature activated`。用户配置、默认值、项目覆盖、CLI 临时加载、信任状态和旧进程未重启都可能导致差异。

### 2.2 宿主与自维护仓库

| 对象 | 委托方已核实的基线 | 公开入口与研究要求 |
| --- | --- | --- |
| Pi | 可执行程序版本为 `0.85.1`；包名 `@earendil-works/pi-coding-agent`；不凭此断言所有存量进程的版本 | [earendil-works/pi](https://github.com/earendil-works/pi)，定位对应 release/tag/commit；不要拿其他 fork 或最新主分支替代 |
| 自维护 extensions | `@csheng/pi-extensions` `0.1.0`；源码 HEAD `f86a72dd985224dcbd415de00e14771c69552e63`，盘点时工作树干净 | [CsHeng/pi-extensions 固定提交](https://github.com/CsHeng/pi-extensions/tree/f86a72dd985224dcbd415de00e14771c69552e63) |
| 本地发布快照 | `~/.pi/agent/packages/csheng-pi-extensions`；`package.json`、`config/`、`extensions/` 与上述源码逐项比较一致 | 不把源码 checkout 当成日常 Pi 的加载路径；`0.1.0` 本身不足以识别这份快照 |
| Skills | [CsHeng/agent-skills](https://github.com/CsHeng/agent-skills/tree/e0d4a230fc70355181709b911ab4b546177b13b4)，HEAD `e0d4a230fc70355181709b911ab4b546177b13b4`，盘点时工作树干净 | `src/skills/` 是 authored truth；`skills/` 是生成的 root-flat 发布内容，不要建议直接编辑生成文件 |
| Skills 安装 | `~/.agents/skills/*` 是逐个指向上述仓库发布内容的 symlink | 只说明磁盘安装关系，不保证每个 agent 的实际发现、同名冲突处理或当前会话加载情况 |

公开 URL 是定位入口，不是公开可达性证明。打不开某个提交时先列出缺失证据和最小附件需求，继续独立的公开部分；不要改用最新分支后仍声称审计了本地版本。

### 2.3 全局配置中的 packages

下表同时列出磁盘上的实际 manifest 版本和全局配置选择。它不是进程加载回执。

| Package / source | 本地版本或 revision | 配置选择及注意事项 |
| --- | --- | --- |
| `npm:pi-mcp-adapter@2.31.0` | `2.31.0` | package 被选中，`skills: []`；不能把禁用它的 Skills 误读为禁用 extension |
| `npm:@juicesharp/rpiv-todo` | `2.10.1` | `extensions: []`，其 extension 被配置排除；只核对排除语义与是否有其他加载路径，不当作当前活跃写入者 |
| `npm:pi-web-access` | `0.29.0` | package 被选中；研究实际入口及它暴露的工具、提示与 UI，不只看 `web_search` 名称 |
| `npm:pi-cc-extensions` | `0.8.71` | package 被选中；`claude-code-style.json` 显式设置 `enableWorkingMessage: false`，其他功能仍需结合该版本默认值解析 |
| `packages/csheng-pi-extensions` | `0.1.0`，内容见固定提交 | 显式排除 `-extensions/plan-mode/index.ts`；其余八个入口没有在此配置中被排除 |
| `git:github.com/NVlabs/SoL-Pi` | manifest `0.1.0`；Git HEAD `bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1` | 工作树只有 `package-lock.json` 的已跟踪修改；不能宣称整个安装完全 pristine；源码功能开关见下文 |

公开源码入口：

- MCP adapter：[nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)。
- Web access：[nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)。
- CC extensions：[minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)。
- RPIV todo：[juicesharp/rpiv-mono 的 packages/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)。
- SoL-Pi：[固定提交](https://github.com/NVlabs/SoL-Pi/tree/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1)。

npm 包要定位到上述实际安装版本对应的发布源码或 tarball；如果 tag、仓库代码和发布包不一致，明确以哪个为证据。新版本修复只能列为升级候选，不能代替本地版本结论。

本地 `sol-pi.json` 的四个布尔开关为：`actionFusion: true`、`observationPack: true`、`evidencePreservingReducer: false`、`onlineContextCompact: true`。入口 `src/sol-pi/index.ts` 在 `session_start` 后按解析配置注册功能；这是高优先级调查对象，尤其是工具形状、观察压缩与上下文压缩的相互影响。仍需核对默认值、受信任项目覆盖和初始化时机，不能只凭全局文件推导最终配置。

### 2.4 自维护的九个 extension

完整集合为 `plan-mode`、`multi-skill-mentions`、`fast-gpt`、`subagents`、`herdr-handoff`、`status-footer`、`work-timing`、`subagents-ui`、`workflow`。即使 `plan-mode` 当前被排除，也应保留它的禁用态说明，以支持未来取舍。

以下只是已检查到的源码入口和研究种子，不是完整行为表：

| Extension | 已知介入点或边界 |
| --- | --- |
| `plan-mode` | `setActiveTools` 切换/恢复工具；`before_agent_start` 追加指导；session 事件恢复 branch-local 状态；当前配置排除 |
| `multi-skill-mentions` | `session_start` 注册 autocomplete；`input` 展开显式 Skill mentions；不是独立的 Skill 发现或执行引擎 |
| `fast-gpt` | `before_provider_request` 修改受支持请求的 `service_tier`；不要混同选择模型或计费权威 |
| `subagents` | 注册 `csheng_subagent_sessions`，执行显式、有界、前台的 managed delegation；候选 apply/close 由父代理显式决定 |
| `herdr-handoff` | 注册显式用户请求限定的 Herdr bridge；不是自动改派，也不是下述 Herdr 状态上报集成 |
| `status-footer` | `ctx.ui.setFooter` 替换 TUI footer，读取其他组件的 keyed status；不拥有 working line |
| `work-timing` | 观察流、工具和 settlement 事件；`setWorkingMessage` 写 working line；settlement 后写 completion entry |
| `subagents-ui` | 只读 observer，TUI overlay；不得把观察面当调度权或完成判定权 |
| `workflow` | `goal-host.ts` 注册 v2 completion contract，观察输入/工具证据、修改 `context`，并在符合条件的 settlement 后请求普通 follow-up；不是“只显示 task list” |

当前仓库规定 `work-timing` 与 CC 的独立 working-message writer 不应同时开启；本地 CC 配置已显式关闭该功能。应把它列为**已配置的共存条件**，不能报告成已复现的冲突，也不能由此断言其他 CC 渲染行为没有影响。

### 2.5 两个 loose extensions 与外部边界

`~/.pi/agent/extensions/` 还存在下面两个自动发现候选。研究者看不到本地文件时，可使用这些 L-source 摘要，不得为它们编造公开源码对应关系。

| 文件 | 版本锚点与本地源码摘要 | 尚未验证 |
| --- | --- | --- |
| `agent-bark.ts` | SHA-256 `d421b4af8e6ff18336b8502587b9cd9e10ee3b5f18c761e132a6b8b624c7dcbe`；`before_agent_start` 和 `agent_settled` 启动并 await 本地 hook；stdin JSON 含事件名、session/cwd、最多 300 字符的助手摘要；等待上限 5500ms | hook 程序自身的行为、是否可用、是否发出网络通知、进程实际加载与延迟 |
| `herdr-agent-state.ts` | Herdr-managed integration version `8`；SHA-256 `9b1c41cd72520fc2abe5f2a2aec995c12a926cce844df472c7fd5fcae4f4dbfa`；环境条件满足后，TUI/session、agent 与 `herdr:blocked` 事件向 Herdr socket 上报状态和 session 引用 | 环境条件是否满足、接收端行为、当前进程实际激活情况 |

二者与扩展工具 `herdr-handoff` 分别列行。观察类扩展也可能增加等待、spawn 进程或发送数据；“不修改 prompt”不等于“无副作用”。不要为了补齐研究而调用通知、socket 或真实 Herdr recipient。

### 2.6 指令与 Skills 的当前事实

- 当前 `~/.pi/agent/AGENTS.md` 保存持久用户偏好、主机资源/清理约束、恢复提醒和薄 Skill 入口；项目 `AGENTS.md` 保存仓库规则。这是当前安排，允许研究评价其不足，但不是迁移授权。
- `agent-skills` 当前架构强调 provider-neutral semantic guidance；`use-coding-skills` 是有条件的路由/恢复帮助，不是每次调用都必须经过的 gateway。
- `tool-decision-tree` 的 description 和 Purpose 明确排除 routine `rg`、普通文件读取、普通仓库状态检查；正文仍包含 `fd → find`、`rg → grep`、不要仪式性 `command -v` 等偏好。**需要研究的是：这些偏好在 Skill 未加载时靠什么生效，而不是误称每次 `rg` 都会加载整个 Skill。**
- 该 Skill 还包含非平凡工具选择、结构化搜索、JSON/YAML 处理、跨 interpreter 引号边界、reviewable scratch script、COUNT/PREVIEW/EXECUTE 和破坏性动作约束。这些内容不能与简单工具偏好一起整包机械搬迁。
- 已检查的 Pi `0.85.1` `buildSystemPrompt` 代码，会根据可用工具生成部分指引；仅有 bash 而没有 grep/find/ls 工具时，已有 `Use bash for file operations like ls, rg, find`。它并不自动等同于“文件发现优先 fd”。custom system prompt 路径与默认 prompt 路径也不同，需研究替换后丢失什么。

Skills 的重点源码：`src/skills/disciplines/tool-decision-tree/`、`src/skills/session/use-coding-skills/` 及其 `references/preference-contract.md`、`src/skills/session/output-styles/`、`src/skills/policies/shell-guidelines/`；同时核对 `contracts/skills.toml` 和发布后的 `skills/`。扩大到其他 Skill 时先列候选，不要求对每条语言领域知识做无差别迁移审计。

## 3. 工作包 A：先重建 Pi 的原生行为与介入权限

以固定版本 host 实现为准，给出下面的主链，并把各扩展挂到相应位置：

```text
资源发现 / package 选择 / trust / session 恢复
  → 用户输入 / commands / Skill 与模板展开
  → before_agent_start / system prompt 组装
  → 每轮 context / provider payload
  → 流式输出
  → tool preflight / execution / result
  → 后续 turn / steering / follow-up
  → agent_end / agent_settled / idle
```

旁路单独画出：TUI/editor、compaction、session switch/tree/reload、abort/error、shutdown、持久化、外部进程/I/O。不要把所有事件强行画成永远只出现一次的直线流程。

逐点回答：

1. hook 何时发生、可见数据是什么、能否修改/阻断/替换/追加/触发后续工作；观察事件与控制能力分别是什么。
2. 同名 handler 的注册/加载顺序是否稳定、是否串行 await、返回值如何合并、是否短路、异常如何处理；异步注册是否影响顺序。给 host dispatch 源码，不只引文档概述。
3. `input`、`before_agent_start`、`context`、`before_provider_request` 改动分别进入了哪里；什么进入 session history，什么只影响本次请求；模型最终看到的内容为什么不能由一个较早 hook 的快照证明。
4. `agent_end`、`agent_settled`、`waitForIdle`、pending queues、`sendUserMessage` / `sendMessage` 与 `triggerTurn` 的契约分别是什么；谁请求 continuation，谁真正拥有 host loop。
5. 不遗漏 `registerTool`、同名内置工具覆盖、工具描述/`promptSnippet`/`promptGuidelines`、`setActiveTools`、commands/shortcuts、UI setters、event bus、`appendEntry`、`ctx.compact` 等非事件 API。具体可用性必须查该版本。
6. 区分公共 API、未文档化接口、prototype/renderer patch、任意 Node/进程 I/O；extension 不自动具备 sandbox 或跨所有执行路径的完整拦截能力。
7. TUI、RPC、JSON/print、SDK、子代理加载面有何不同；不要把 `hasUI` 与 `mode === "tui"` 当同义条件。子代理若禁用 Skills/extensions，必须单独说明父级偏好是否会丢失。

优先阅读 Pi 的 `docs/extensions.md`、`docs/skills.md`、`docs/packages.md`、相关 prompt/context loading 文档，以及 `packages/coding-agent/src/core/` 内的 system prompt、resource loader、extensions runner、agent-session 和实际 agent loop 实现。路径若变动，记录查到的真实位置。

## 4. 工作包 B：当前组合的行为表与排障图

### 行为表格式

**每行是一个行为，不是一个 package。** 同一 package 的工具注册、上下文改写和 UI patch 应分开。至少包含：

| ID | 所有者/版本/功能 | 激活条件与模式 | Hook/API/其他机制 | 原生行为 → 改后行为 | 共享读写目标与组合语义 | 状态/持久化/清理 | 隔离/禁用/恢复 | 证据与未知 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

禁用方法要核实是关闭一个功能、排除入口、重启还是 reload；区分“停止未来副作用”“恢复宿主 UI/工具”与“清除或保留历史”。不要把删除安装目录作为默认排障手段；配置调整只作为待授权建议，不执行全局设置修改。

### 优先调查的交叉点

- **输入与上下文**：multi-skill 展开、CC references/features、SoL observation/compaction、workflow 输入对齐与证据关联；压缩是否改变或丢失其他扩展需要的标记、身份或记录。
- **工具形状与执行路径**：SoL action fusion、MCP gateway、内置/自定义工具与工具覆盖；融合/嵌套调用是否仍产生同一组 tool 事件，错误/取消/并发语义是否相同。不要假设每个内部操作都经过顶层 `tool_call`。
- **UI 写入目标**：CC renderer、working line、footer、autocomplete、overlay、tool card 和 completion entries；以共享 mutation target 判断冲突，不以“订阅了同一个事件”作为证据。
- **完成、续跑与压缩**：workflow 的 settlement follow-up、SoL 的 plan/compaction 触发、host queues、子任务前台等待；区分主动追加消息与只观察结束。
- **耗时与外部副作用**：Bark 的 awaited hook、Herdr 状态上报、第三方网络/浏览器/MCP 执行；这些边界不能被包装成模型推理耗时或安全沙箱。
- **恢复与切换**：branch-local 状态、session entries、reload 残留、headless 行为、异常清理；工具/UI 恢复时是否覆盖了别的 extension 的后续设置。

这些是调查问题，不是已成立的漏洞或冲突。特别要给出“共享目标但安全组合”“配置已避免”“确有覆盖/顺序依赖”“证据不足”四类结论。

### 按症状的排障入口

至少覆盖：模型收到意外文本；工具消失/形状改变/被阻断；工具结果被截断或替换；停止后又继续；UI 闪烁/working 信息消失；压缩后遗失证据；切 session 后状态错误；等待时间异常或外部通知异常。

每项列出可能写入者、只读可观察证据、最小 A/B 隔离顺序、预期区分信号和回滚方式。无关扩展不要一律重装；当前未启用的行为不要排为首要嫌疑。

## 5. 工作包 C：Skills、偏好与 Pi 原生能力的归属

### 先拆开三个维度

**内容所有权、注入机制和执行保证不是一件事。** 一条便携偏好可以只有一个 authored source，经不同宿主入口投影；一个 extension 也可能只追加 prompt，完全没有提高强制性。`AGENTS.md` 和 `APPEND_SYSTEM.md` 即使最终都进入 prompt，发现、作用域、维护和覆盖语义仍可能不同。

比较以下候选，允许“保留/删重/拆分”，不要把它们预设成互斥选项：

- 按需加载的 portable Skill。
- 持续注入的 harness-global instructions，如 `~/.pi/agent/AGENTS.md`；与项目 `AGENTS.md` 分开。
- `APPEND_SYSTEM.md` / append-system-prompt；与 `SYSTEM.md` / 完整替换分开。
- 工具的 description / snippet / guidelines，或基于当前 active tools 的薄 prompt 适配。
- Pi extension 的确定性实现，如有明确输入输出的工具、工具选择、事件转换或可观察机械约束。
- 用户维护的共享偏好源及各 agent 的最小 adapter；不要默认一定要新建生成器或同步服务。

对每种方案比较：触发/发现可靠性、每轮上下文成本及 prompt-cache 影响、约束力度、误拦截与逃逸、可调试性、作用域、跨 agent 可移植性、版本耦合、测试和维护成本、停用后的退化路径。不能只用 token 更少作为迁移理由。

### 最少审计到这些规则粒度

| 规则 ID | 当前规则样本 | 必须做出的判断 |
| --- | --- | --- |
| R1 | 普通文本搜索优先 `rg`，文件发现优先 `fd`，失败时明确 fallback | 跨 agent 的内容源放哪里；Pi 是否已有等效指引；CLI 与宿主原生 search/find 工具如何比较 |
| R2 | 不在普通搜索前仪式性检查工具是否安装 | 持久偏好还是任务方法；缺工具/远端/CI 的例外如何保留 |
| R3 | `rg` 无匹配、PCRE2、ignore/hidden、输出边界与平台方言 | 哪些属于按需知识；工具 wrapper 是否会改变命令语义或忽略用户明确请求 |
| R4 | 大范围搜索/修改前 COUNT/PREVIEW/EXECUTE | 保留语义判断还是可机械执行；避免给小操作加无意义 ritual |
| R5 | 结构化 JSON/YAML/AST 处理、避免多层引号、reviewable scratch script | 为什么不应简单改成“一律用工具 X”；与 shell/language overlay 的边界 |
| R6 | 禁止无授权破坏性操作、提交/发布等边界 | prompt 提醒、Pi 局部拦截与真正执行环境权限分别能保证什么；扩展不能自授权限 |
| R7 | 输出语言、简洁程度、少发可选 commentary | 持续用户偏好与按需 `output-styles` 的分工；是否存在重复注入 |
| R8 | 直接匹配 Skill 可绕过 router、条件式 review、父代理最终验收 | portable 语义是否仍需保留；不能把代码工具的成功结果等同于语义完成 |
| R9 | bounded delegation、完成状态/证据绑定、continuation 机制 | 与已有 subagents/workflow 的机制边界如何划分，哪些语义判断不可交给通用状态机 |
| R10 | compaction 后恢复、临时资源归属和清理 | 哪部分应持续可见，哪部分由 host/session/程序负责；跨宿主如何验证等效结果 |

每条必须输出：当前 owner/path、实际加载条件、建议 owner、必要的 Pi adapter、其他 agent 的退化或适配、迁移/不迁移理由、验证方式。不要将整个 Skill 标成“迁移到 extension”后跳过内容拆解。

### `rg` / `fd` 必须做一次端到端 worked example

给出不超过一小段的共享偏好正文样例，以及 Pi-only 与多 agent 两套承载方式的示例，均标为建议、不可直接当实施指令。至少覆盖：

1. 普通搜索时 Skill 未加载，偏好是否仍然在模型输入中；加入全局指令后是否与 host tool guidelines 重复。
2. Pi 有原生 grep/find 工具、只有 bash、MCP/自定义搜索工具、子代理使用不同工具集时，偏好如何适用或退化。
3. `fd` 不存在、`rg` 返回无匹配、用户明确要求另一个工具、需要 PCRE2 或忽略规则时，是否保留正确例外。
4. 对比三种强度：自然语言偏好、专门 search 工具、拦截/改写任意 bash。明确第三种的解析、引用、平台和绕过问题，不默认推荐静默把 `grep/find` 改写成 `rg/fd`。
5. 把“可测地减少错误/无用调用”与“看起来更 Pi-native”分开。只有 host integration 带来额外可证明收益时才建议扩展化。

## 6. 工作包 D：跨 agent 的一致性与取舍

至少比较两种有效目标，不替用户决定以后只使用 Pi：

- **Pi-only 优化**：充分使用 Pi 原生工具提示、资源发现和扩展能力，同时计算升级、组合和调试成本。
- **Portable core + thin adapters**：保留便携语义和共享偏好，用尽可能薄的 Pi / Codex / Claude Code 入口表达各自机制。

研究 Codex、Claude Code 时，明确产品/CLI 版本或文档日期，区分官方支持的全局/项目指令、Skills、hooks、tools 与非官方手段。不能假设这些 agent 都自动读取 `~/.agents/skills`、都读取全局 `AGENTS.md`，或指令组合优先级完全相同。

候选分发方式可以包括明确的相对引用、symlink、构建时生成或轻量复制；分别检查宿主是否真正加载正文、路径是否可移植、同名重复发现、是否有独立可编辑副本、更新和回滚成本。**只写“请阅读共享偏好文件”不等于偏好已可靠注入。**

回答：

1. 唯一内容源应是什么，哪些 adapter 只是运输层，哪些差异必须由宿主独立维护？现有 Skills authored/generated 布局是否可以复用，还是应保持独立？
2. 哪些行为要求跨 agent 严格等效，哪些只是偏好，哪些是可接受的 native enhancement？给出具体例子与退化说明。
3. 同时采用可移植正文和 Pi prompt adapter，怎样避免同一规则被注入两次、相互冲突或被压缩丢失？谁负责验证实际 prompt，而不读取/公开敏感用户内容？
4. 用什么准则判断多 agent 兼容成本已超过收益？给出条件化推荐，不做没有证据的百分比评分。
5. 迁移顺序怎样保持可逆？先删重/补持续偏好，再试薄适配，最后才评估新工具或拦截器，是否合理；若不合理，请用证据反驳。

## 7. 最小验证设计：研究报告要给方案，不执行本地变更

公开静态研究不能证明本地组合效果。请给出一个本地后续可运行的最小验证矩阵，注明预期 oracle：

| 场景 | 要区分的事实 | 可接受证据 |
| --- | --- | --- |
| 无 extensions / 单个 / 当前组合 | 谁改变 prompt、工具表、UI 或后续轮次 | 固定输入、脱敏阶段摘要、事件顺序和行为差异；先证明测试真正加载了目标 |
| 配置开/关与 reload/restart | 禁用是否只影响未来行为，是否留有状态 | active tools、writer 生命周期、session 状态的前后对照 |
| native input / Skill mention / extension follow-up | 不同来源如何变换和进入历史 | source 标识和各阶段摘要，不能用一个早期 hook 代替最终请求 |
| sequential / parallel / fused / nested tools | 证据、取消、结果和计时事件是否一致 | 受控 fake tools 的确定性事件轨迹，不必真实启动 provider/MCP |
| compaction / tree / resume / abort | 状态、偏好和证据是否保留或正确失效 | disposable session、固定 fixture、失败注入及恢复结果 |
| TUI / RPC / print / child | 功能是否误激活、偏好是否遗漏 | 模式对应的工具清单、输出与无 UI writer 证据 |
| Pi / Codex / Claude Code 的 R1–R3 | 偏好载入是否成立，执行是否等效 | 先验证资源和 prompt 装配；模型遵循效果另设显式授权的有限实验 |

结构确定性测试与模型服从性测试分开。没有真实模型实验，就不宣称“更可靠”“减少多少 token/调用”已被验证。对 prompt-cache 只能先分析稳定前缀与动态写入风险，实际节省需要可比样本。

优先离线、fake-Pi、disposable settings/session；不启用 QEMU 或常驻服务来解决源代码即可回答的问题。所有真实 provider 调用、外部副作用或用户配置修改都另行申请范围。需要本地证据时列出最少字段，不索取完整 settings、credentials、provider/model 选择、路由文件或 session 正文。

## 8. 交付物与验收标准

请按以下顺序返回**一份报告**，可以附机器可读表格，但不要把缺少的结论藏进多个附件：

1. **一页结论**：最重要的行为改写、已避免/仍未知的交互、Pi-only 与多 agent 的条件化推荐；列前三项最值得进一步处理的事项。
2. **固定版本来源清单与覆盖账本**：每个 package、入口和功能的已覆盖/未覆盖状态；公开不可达与本地未知分别标记。不能仅抽查几个 extension 后称为“全部”。
3. **Pi 原生链路图 + 行为表**：覆盖九个自维护 extension、配置选中的第三方功能、两个 loose integration 边界；对排除的 rpiv-todo 和 plan-mode 给出清楚的禁用态。
4. **交互与症状排障表**：每个高风险结论给因果链、版本、触发条件、证据、隔离和回滚；共享事件本身不是冲突证据。
5. **规则归属矩阵**：至少 R1–R10，特别完成 `rg` / `fd` worked example；给出保留、删重、拆分、迁移或待证据的明确判断。
6. **两种路线的取舍与分阶段候选 backlog**：每项写收益、代价、源文件 owner、需要的权限、验证和退回原状的方法；不是直接生成“已获批实施计划”。
7. **最小本地验证矩阵与开放问题**：静态源码已足够的不要要求重演；会改变结论的未知优先。列明什么证据会推翻推荐。

每条重要技术结论要尽可能同时引用 extension 的实现与 Pi 消费该 hook/API 的实现。用固定 commit permalink、文件路径/行号，README 只能辅助解释意图。文档与源码不一致时说明差异；源码可解释不等于当前进程已触发。

如果时间不足，先完成版本/覆盖账本、核心组合的共享写入目标、R1–R5 与两路线取舍；其余明确保留为未完成，不以泛泛架构建议代替全量证据。

## 9. 不做什么

- 不修改本地 Pi、Skills、全局/项目指令或用户设置，不安装、卸载、升级、发布、commit 或运行真实 provider probe。
- 不假定应删除所有 Skills、把所有规则硬编码进 extensions、或者让 Skills 仓库成为 Pi 的运行时注册中心。
- 不把 native adaptation 做成另一个 scheduler、workflow engine、权限授予者或自动 review/acceptance 系统。若推荐改变现有边界，作为独立待批准设计议题，而非暗中越界。
- 不把工具注册/候选 apply/进程成功当成语义验收，也不把 prompt 提醒、工具拦截或 read-only 标记当成 OS 安全隔离。
- 不外发原始用户配置、会话、凭据、私有路径内容或完整系统 prompt；本文脱敏基线之外的附件先由委托方确认。
- 本报告只提供证据与建议；后续是否更新稳定行为地图、迁移偏好或实施 extension 变更，由用户另行决定。
