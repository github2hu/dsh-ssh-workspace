# 更新日志

本文件记录 dsh-ssh-workspace 的版本变更。0.1.16 之前的版本为未公开的本地迭代，未收录。

## [0.3.2]

### 新功能

- **已停用工作区的「彻底删除」**（`lib/client.js`）：侧栏「已停用的工作区」每一行在
  「启用」旁新增「彻底删除」，**点击后弹窗二次确认**（对话框自身承载「确认删除 / 取消」，
  关闭点击遮罩、Esc 之外的路径都由对话框按钮决定），确认后调用既有的
  `POST /api/dsh-ssh-workspace/unmount`（`mode: "forget"`、`archiveSessions: false`），
  清除本机的 DSH 工作区登记与停用标记。**远端目录、会话日志一律保留**——DSH 没有公开的
  会话删除 API，插件也不绕过服务层去 unlink 日志。归档步骤被跳过：停用时已经归档过，
  重复归档可能因会话又在别处运行而被拒，对这里也没有任何增益。
- `tests/client-shape-smoke.mjs` 增加 12 项断言：中英两套语言都必须有这些标签、
  请求体必须是 `forget` 且不动归档、行按钮只开对话框不直接删除、对话框可取消、
  复用既有遮罩/对话框样式与危险按钮样式。

## [0.3.1]

### 新功能

- **侧栏 git 可读取远端仓库**（`lib/patch-child-process.js`）：侧栏源码管理面板
  （`dsh-better-sidebar`）用 `spawn("git", ["-C", cwd, …])` / `execFile("git", …)` 读取仓库状态，
  `cwd` 为 `ssh://` 时本地 git 必然失败。现在接管宿主进程的 `node:child_process`：
  目标为远端时改在远端执行，并用 ChildProcess 形状的对象回放结果（`stdout`/`stderr` 流、
  `error`、`close`、`kill`），`execFile` 回调形态同样处理。只桥接 `git`；本地调用与其他命令
  原样转发。环境只透传 `GIT_*`/`LC_*`/`LANG` 并强制 `GIT_TERMINAL_PROMPT=0`。
- **破坏性 git 命令被拒绝**：`push --force`/`-f`/`--mirror`、`reset --hard`、`clean -f`、
  `branch -D`、`update-ref`、`reflog expire`、`gc --prune`、`filter-branch`。
  侧栏按钮没有确认界面，这类命令需要在远端终端里执行。
- 新增 `tests/child-process-smoke.mjs`（34 项断言）。
- 新增只读诊断路由 `GET /api/dsh-ssh-workspace/diagnostics`：返回 git 桥是否安装，
  以及最近 32 次被接管的调用（别名、远端 cwd、argv、退出码）。用于区分
  「侧栏没发出请求」与「桥接没生效」。
- **修复：侧栏仍显示「不是 git 仓库」**。`git rev-parse --show-toplevel` 的答案原本是
  裸 POSIX 路径（`/home/u/repo`），侧栏把它当成宿主绝对路径（Windows 上变成 `C:\home\…`），
  于是后续 git 调用不再带 `ssh://`、绕开桥接、由本机 git 报「不是仓库」。现在桥接把
  `--show-toplevel` / `--absolute-git-dir` / `--git-dir` / `--git-common-dir` /
  `worktree list` 的路径答案翻译回 `ssh://<别名><路径>`；`status` / `log` / `diff` 的
  相对路径不动。

## [0.3.0] — fork 首版

本版是 [`siqyka/dsh-ssh-workspace`](https://github.com/siqyka/dsh-ssh-workspace) 0.2.3 的
fork，由 github2hu 维护，补齐两项在远端工作区里缺失的能力。

### 新功能

- **远端项目技能**（`lib/remote-skills.js`）：通过 `ctx.skills.registerProvider()` 注册
  名为 `ssh-workspace` 的技能提供者，经已打补丁的 `ctx.fs` 在远端发现并加载
  `<工作区>/.dsh/skills`、`<工作区>/.agents/skills` 下的技能（目录包与扁平 `.md` 两种形态）。
  项目根取最近的含 `.git` 祖先；只扫一层；正文每次加载重读；目录变化用 `ctx.fs.watch`
  感知（远端 inotifywait 或轮询），因此新增 / 改名 / 删除技能无需重启。
  远端项目技能 rank 为 90 / 190，高于本机用户级技能，与 `dsh-skills-manager` 等
  提供者按 rank 合并。可用 `skills.enabled` / `skills.watch` 关闭。
- **`run_code`（PTC）在远端工作区可用**（`lib/ptc-local.js`、`lib/patch-sandbox.js`、
  `lib/patch-subprocess.js`）：上游的远端 subprocess 桥只允许 `git` / `rg`，PTC 的 Node
  子进程因此被同步拒绝，模型只能报「无法读取文件」。现在把该子进程（以
  `stdio.control === 'pipe'` + Node 形态识别）放到本机私有临时目录运行，并同步把
  `ctx.sandbox` 的围栏根换成同一目录；程序通过 PTC 绑定调用 read / write / edit /
  glob / grep 访问远端文件，子进程环境带 `DSH_REMOTE_PTC_WORKSPACE`。
  仅支持 `executionMode: per-call`；`persistent-in-memory` 的 REPL 会因 `chdir` 到
  `ssh://` 而失败。
- 系统提示词段落补充上述两项能力与用法约束。

### 变更

- 包名改为 `@github2hu/dsh-ssh-workspace`；loader 行 id 改为 `ssh-workspace-fork`
  （避免与上游的 `- id: ssh-workspace` 补丁条目互相覆盖）。
- 新增两个 smoke 套件：`tests/remote-skills-smoke.mjs`、`tests/ptc-local-smoke.mjs`。

## [未发布]

### 新功能

- **端口转发持久化**：映射写入 `dsh-ssh.json` 的 `forwards` 分区，面板可开启 / 断开 /
  删除单条映射，并有「启动时自动开启隧道」总开关。核心是把**意图**（`enabled`，
  用户想要什么）与**事实**（`live`，当前是否真有 listener）分开存：按钮文案由事实
  决定，启动行为由意图决定，否则重启后连接尚未建立、按钮却写着「断开」就是谎报。
  已存映射强制严格端口模式——本地端口被占用就报错，不再静默漂移到临时端口，否则
  保存的 URL 会在下次启动时失真。新增 `POST /forward/probe` 做本地端口预检
  （`EADDRINUSE` / `EACCES` 分别给不同文案），但它只是提前告知原因，真正的权威
  仍是 `open()` 抛出的绑定错误。
- **面板列表上限**：主机、端口转发、已挂载工作区三个列表超过 5 条时改为滚动视口。
  上限高度按前 5 行的实测高度求和，不写死行高——行高会随描述、错误行、确认行
  以及面板宽度变化，写死会在一类行上露出半行、在另一类上只剩三行。没有溢出时
  不预留滚动条位置，渲染结果与加此功能前完全一致。
- **工作区停用 / 启用**：卸载改为**可逆**。默认的 `detach` 模式保留 DSH 工作区记录
  （侧边栏那一行仍在，置灰），并把该工作区的会话**归档**——用 DSH 原生
  `workspaceRegistry.archiveSession()`，会话从列表隐藏但文件与记账槽位都不动，
  `unarchiveSession` 能把它们放回原位。没有引入任何新依赖，也没有绕过服务层去
  unlink 会话日志（那是不可恢复的，而 DSH 并没有公开的删除会话 API）。
- **停用即全局停机**：停用的工作区对**除 SSH 连接外的一切操作**都被拒绝——读文件、
  列目录、写、变更监视、执行命令、开终端、glob / grep / git、文件传输。围栏挂在
  `engine.disabledWorkspaces` 上，在 `ctx.fs`、内建 fs 桥、`ctx.shell`、
  `ctx.subprocess`、终端接管层与两条传输路由里同时生效，且都在建立连接**之前**
  拒绝。主机面板、不带 cwd 的 `ssh_workspace_exec`、端口转发照常可用。
  刻意保留的例外：内建桥的 `stat` / `lstat` / `realpath` 不挡，因为 DSH 的 registry
  用它们做会话身份探针，在那里制造失败会让它把会话从工作区记账里剪掉——卸载一个
  工作区不该顺手改写它的会话归属。
- **`ssh_workspace_enable`**：新增工具与 `POST /enable` 路由，重新挂载并取消归档。
  启用前会 `stat` 验证远端目录仍存在，避免得到一个「看起来在服务、实际 ENOENT」
  的工作区。

### 变更

- `ssh_workspace_unmount` 的 `deregister` 默认值由 `true` 改为 **`false`**（即默认
  `detach`）。旧的 `deregister: true` 仍被识别为 `deregister` 模式，不会静默降级。
- `ssh_workspace_unmount` 参数新增 `mode` 与 `archiveSessions`，返回新增 `mode`、
  `archived[]`、`archiveFailed[]`。
- `ssh_workspace_status` 返回新增 `disabled[]`（已停用工作区）。
- `/status` 响应新增 `disabled[]`；浏览器端据此把侧边栏对应行置灰（仅视觉，
  不拦截 DSH 自己的行点击，那会在宿主改版时崩）。

### 修复

- **HMR 重复插入**：向输入框拖入一个文件会生成约 22 个同样的 chip。根因是每次
  重新加载模块体都会新增一组 `document` 监听，而旧的监听并不会随旧闭包回收。
  改为把「已处理事件」集合挂在全局并以事件对象为键，一次派发只被消费一次；
  同时 `apply()` 返回 disposer 拆除监听。
- **本地化词典未更新**：`forwards.autoStart` 等新键渲染成原始键名。根因同上——
  重复 `register` 抛错被 `catch` 吞掉，`bind` 继续服务**旧**词典。改为经
  `ctx.effect` 注册以便随实例拆除，并让 `translate` 在拿到原始键名时回落到本地
  zh 表。
- **`.sshwsp-empty` 规则被误删**：列表改造时把这条规则一起删掉了，所有空态 /
  加载中 / 错误占位符静默失去内边距与居中。已恢复，并新增一条**渲染类 ↔ 样式
  声明一致性**检查防止再退化。
- **`ssh_workspace_enable` 会被自己的围栏挡住**：工具用 `engine.fs.stat()` 验证远端
  目录，而 `engine.fs` 正是那层围栏——它会拒绝停用工作区内的任何读取，于是「启用」
  在结构上不可能成功。改为走原始连接（`engine.withSftp`）直接 `stat`，与 HTTP 路由
  的做法一致。`ssh_workspace_mount` 有同一处问题：重新挂载一个已停用的工作区是复活
  它的常规方式，同样必须绕过围栏探测。两条都加了回归测试，并验证过把修复回退后
  测试确实变红。
- **`forget` 模式只清清单、不清围栏**：该模式删掉工作区记录后只调用
  `enableWorkspace()` 清持久清单，却没有 `enableRoot()` 摘掉运行时停用标记，于是留下
  一个「面板里已无这一行、运行时却仍拒绝一切操作」的工作区——而「启用」按钮恰好长在
  `forget` 清空的那份停用列表上，用户无从恢复。补上 `enableRoot()`，并加了回归测试
  （先写测试确认它变红，再修）。

### 测试

- 新增 `tests/forward-persist-smoke.mjs`、`tests/insert-once-smoke.mjs`、
  `tests/locale-register-smoke.mjs`。
- 新增 `tests/peer-stubs.mjs`：`DSH_CORE_ROOT` 未设置时自动生成最小 peer stub
  根，让依赖 `routes.js` / `remote-fs.js` 的套件真正**运行**而不是跳过。跳过
  的套件无法失败，而正是这样一次跳过让一个调用了未导入函数的 upload 处理器
  绿着发了出去。需要真实框架的三个套件（`lifecycle` / `boot` / `tool-schemas`）
  仍会明确 SKIP 并给出原因。
- 新增 `tests/detach-smoke.mjs`（62 项）：停用清单的读写与脏数据退化、路径包含判定、
  `ctx.fs` 十个方法逐个断言被拒、重新启用两条路径、shell / terminal 拒绝且**没有
  打开任何连接**、工作区外与别的 alias 必须照常可用、跨分区写入不互相覆盖、
  以及「启用 / 重新挂载不得经过围栏探测」这条回归。
  `routes-smoke` 增至 80 项（三种卸载模式、归档失败上报、启用流程、`forget` 必须
  同时清掉清单与围栏、新路由的回环围栏）。
- `lifecycle` 期望路由数 21 → 22、工具数 9 → 10；`boot-smoke` 在真实主机上验证
  挂载 → 停用 → 读被拒 → 启用 的完整往返；`tool-schemas` 增至 160 项。
- 全套 `node tests/run.mjs` **22/22** 通过。

## [0.2.3] - 2026-10-17

### 新功能

- **远端 PTY 终端（`spawnTerminal` 接管）**：新增 `lib/patch-terminal.js`，把部署的
  `ctx.subprocess.spawnTerminal` 在 `ssh://` 工作目录上路由为 SSH PTY 通道。这补上
  了此前唯一的能力缺口——部署自带的持久 bash/pwsh 工具在远端工作区上要么失败、
  要么在本机对着一个只存在于远端的路径启动 shell。返回值满足
  `dsh-terminal-bash` 所依赖的句柄契约（`output` / `write` / `resize` / `done` /
  `inspectForeground` / `signalForeground` / `terminate`）。
  两处刻意的取舍：`argv` 不复用（那是本机方言，远端 POSIX 主机跑不了），改为启动
  远端自己的交互式 `sh`；`inspectForeground` 返回 `undefined` 而非猜测，从而选择
  上层文档化的「输出静默」兜底判定，避免一个错误答案让它等满整个超时。
- **浏览器端下载**：文件选择对话框的每个文件行新增下载按钮，经新增的
  `GET /download` 流式路由取回字节并交给浏览器保存。该路由直接返回原始字节而
  非 JSON（避免 base64 膨胀与体积上限），因此自行重新施加回环来源与 `Host`
  头双重校验，并只接受 GET。

### 测试

- 新增 `tests/terminal-smoke.mjs`（23 项）、`tests/transport-smoke.mjs`（17 项）、
  `tests/routes-smoke.mjs`（11 项），合计 51 项新断言。
- `tool-schemas` 补上 `ssh_workspace_shell`，现在覆盖全部 9 个工具（141 项）。
- `transport-smoke` 首次覆盖 `agentForward` / `compress` 的三层传递（JSON 存储 →
  描述符 → ssh2 配置），以及后台任务的两种路径：有 `jobs` 时注册并返回 id，
  无 `jobs` 时降级为内联执行而不是返回一个没人能读的 id。

## [0.2.2] - 2026-10-17

### 新功能

- **端口转发恢复**：`ssh_workspace_forward` / `ssh_workspace_unforward` 与面板转发
  区重新启用（0.1.21 屏蔽时保留了全部实现）。远端 dev server 映射到本机
  `http://localhost:<port>`，映射随 SSH 连接存活，断开即关闭。
- **持久远端会话**：新增 `ssh_workspace_shell`，在同一 (主机, 会话名) 上维持一个
  POSIX `sh`，`cd`、导出的变量与后台任务跨调用保留。刻意不复用部署自带的
  persistent bash/pwsh 工具——那套工具按**本机方言**构造命令行，Windows 上是
  PowerShell，远端无法运行。
- **本机 ↔ 远端传输**：新增 `ssh_workspace_transfer`，经 SFTP 双向拷贝文件，分块
  流式、不经对话内容；上传先写同级暂存名再 rename 发布，目标文件在被替换前
  始终是旧内容或完整新内容。`recursive: true` 可上传整个本地目录树。
- **`ssh_workspace_exec` 支持后台任务**：`run_in_background: true` 返回 job id，
  输出进入任务环形缓冲，可用 `job_output` / `job_kill` 收集与终止。

### 变更

- **推送式变更监视**：远端有 `inotifywait` 时改用事件推送，变更即时上报且不受
  mtime 秒级精度限制；未安装或无法建立监视时自动回落到原有轮询（2s / 5s / 10s
  自适应退避）。监视通道断开后自动重新挂上轮询，不会静默失效。
- **能力探测**：挂载时一次性探测 `rg` / `git` / `inotifywait`，缺失项在工具返回
  与面板里给出提示，不必等踩到 127 或发现变更面板不工作才知道。探测结果按主机
  缓存，连接关闭时失效。
- **每主机传输选项**：新增 `agentForward`（远端命令用本机 ssh-agent 密钥认证，
  私钥不落到远端）与 `compress`（以 CPU 换带宽）。`~/.ssh/config` 的
  `ForwardAgent` / `Compression` 同样被识别，面板里可开关。

### 修复

- 端口转发的状态查询链路此前仍在运行但入口被注释，导致"功能已屏蔽"的判断
  与实际不符；本次一并澄清并恢复。

## [0.2.0] - 2026-10-14

### 新功能

- 新增 `POST /api/dsh-ssh-workspace/hosts/disconnect`：关闭指定别名的连接池连接；
  仍有在途操作时返回提示而不是强行断开。客户端主机卡片内联展示「已连接」状态，
  可按需断开。

### 变更

- HTTP 路由增至 10 条，`lifecycle` 套件的预期路由数同步更新。

## [0.2.1] - 2026-10-16

### 修复

- **exec 断连误判为正常完成**：通道 `close` 时既无退出码也无信号（`close(undefined)`）
  与 `close(null)` 同等视为传输中断，不再settle成"命令成功"。
- **rename 回退误删目标**：远端无 `posix-rename` 扩展时，`unlink` 目标前先 `stat`
  确认其存在，否则原样抛出 rename 错误，避免失败时误删无关文件。
- **`listDir` 串行 N+1 stat**：直接消费 `readdir` 返回的 `entry.attrs`，仅在缺失时
  回退 `stat`，目录列举从 1+N 次串行往返降为 1 次。
- **存储跨进程写入**：引入零依赖 `O_EXCL` 兄弟锁文件，`mutateHosts` 把读改写整体
  放进临界区；create / update / delete / rememberHostKey / forgetHostKey /
  encryptStoredSecrets 全部改走该路径。
- **`StreamTail` 重复 join**：缓存 join 结果，`push` 时失效，`readFrom` / `finalize`
  共用。

### 测试

- 新增 `tests/phase6-smoke.mjs`（36 项）与 `tests/store-lock-smoke.mjs`（15 项）。

## [0.1.24] - 2026-10-06

### 变更

- 包名由 `@dsh-community/dsh-ssh-workspace` 改为 `@shiqyka/dsh-ssh-workspace`，并加
  `publishConfig.access = "public"`，以便发布到 npm；`cordis.patch.yml` 的插件行
  名称与 `lib/client.js` 的 client 插件 id 已同步。安装时在插件管理界面填 npm 包名
  `@shiqyka/dsh-ssh-workspace`（也可填仓库地址）。

### 安全

- 存储中的密码与私钥口令改为**加密保存**：AES-256-GCM，密文写入 `dsh-ssh.json`
  的 `secrets` 段（按别名），密钥是 `$DSH_HOME/dsh-ssh.key`（`0600`）里的 32 字节
  随机值，首次保存凭据时生成；`auth` 字段不再携带 `password` / `passphrase`。
- 启动时自动把老版本留下的明文凭据加密回写进 `secrets` 段（best-effort，
  迁移条数写入日志），此后 `dsh-ssh.json` 不再出现明文。
- 密钥文件缺失或被更换时，连接明确报错并提示在面板重新保存该主机，而不是
  静默认证失败。

## [0.1.23] - 2026-10-01

### 修复

- 修复会话中 `@` 远端文件引用点击后预览报「读取失败：Maximum call stack size exceeded」：
  远端工作区根下的裸路径会在 `ctx.fs` 路由与本插件之间无限互相委派；`resolve` / `lstat`
  现统一经 `remoteSourceOf` 消化两种裸拼写（相对名继承远端 cwd、绝对 POSIX 名按别名映射），
  不再回递本地后端。

## [0.1.22] - 2026-10-01

### 安全

- 主机密钥 TOFU：首次连接记录指纹，之后不符即拒绝连接；新增 `hosts/forget-key`
  路由与面板「忘记主机密钥」入口。
- HTTP 路由增加 Host 头校验（仅接受回环地址）与 POST `Content-Type` 校验（非 JSON 返回 415）。
- 凭据存储文件 0600、目录 0700，临时文件随机命名；写路径（复制 / 删除 / 发布）
  接入 realpath 围栏校验。

### 修复

- `exec` 输出跨块 UTF-8 解码安全，按字节截断不再切坏字符。
- `exec` 连接断开且无输出时自动重连重试一次。

### 性能

- SFTP 元数据 1.5s TTL 缓存（仅读路径，写 / 删 / 挂载等主动失效）。
- 远端变更监视自适应退避（2s → 5s → 10s）。
- `streamText` 按需启用第二 SFTP 通道，大文件流式读取不占用共用通道。

### 工程

- 新增 `tests/` 脱敏冒烟套件与运行器、GitHub Actions CI、`package-lock.json`、`.npmrc`。
- 引擎连接参数可配（空闲超时 / 连接超时 / keepalive / 回收扫描间隔）。
- `package.json` 补充 repository / homepage / bugs 元数据。

## [0.1.21] - 2026-10-01

### 变更

- 端口转发功能整体屏蔽（面板、工具、公告、路由均注释保留，可随时恢复）；
  相关文档同步移除，本阶段不发布该功能。

## [0.1.20] - 2026-10-01

### 新增

- `@` 文件引用支持远端工作区：输入 `@` 即可搜索并插入远端文件路径。
- 文件进任务：侧边栏文件树支持拖拽到对话框，或右键「添加到任务」，以 `@` 引用形式插入。

## [0.1.19] - 2026-10-01

### 修复

- 修复 0.1.18 引入的工作区向上探测崩溃（报 `not a remote workspace path: "ssh://<别名>"`）：
  路径拼写桥接对裸别名 `ssh://<别名>` 回退原生实现，恢复探测的平静终止。

## [0.1.18] - 2026-10-01

### 新增

- 终端命令远程化：会话工作目录为 `ssh://` 时，命令以 POSIX shell 语义在远端执行，
  前台 / 后台任务、增量输出与取消等行为与本地一致。
- 远端文件搜索（ripgrep）与 git 变更追踪在远端执行。
- 远端变更监视（轮询式）。
- 大文件流式读取（分块惰性读取，跨块 UTF-8 安全）。
- 端口转发（本地监听 → 远端目标；0.1.21 起屏蔽）。

## [0.1.17] - 2026-10-01

### 新增

- 远程路径以 `@` 形式显示：工作区悬停卡片与文件面板路径标签显示
  `ssh://<别名>@/<路径>`（仅显示层，功能拼写不变）。

### 变更

- 发布文件脱敏：示例主机名与用户名替换为占位符；移除已废弃的第三方插件引用；
  README 与 docs 同步更新。

## [0.1.16] - 2026-10-01

### 修复

- 界面文案参数（如 `{ms}`）不再原样输出：插件改为注入 `locale` 服务。
- 对话页工作区按钮标记匹配修复（会话落地前按路径末段匹配、原地文本替换、
  整棵子树挂载时补齐扫描）。
- 连接测试结果 toast 调整为顶部居中显示。

### 变更

- 远程工作区标记图标放大并按图标边界裁剪，16px 下更清晰。
- 界面细节打磨：控件悬停 / 按下与焦点态、菜单与对话框入场动画
  （尊重 `prefers-reduced-motion`）、语义化按钮与空 / 加载态、数字等宽排版。
