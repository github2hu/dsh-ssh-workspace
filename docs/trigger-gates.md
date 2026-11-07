# 触发门禁的一行指令（亲手粘贴版）

> 前提：会话工作区是 `ssh://`，路径换成你自己的。每条都标了**要先把会话切到哪个模式**，以及**该看到什么拒绝**。判定一律用远端实际状态反证（命令 / `read`），不要只看返回值。

围栏顺序：`停用 → 模式 → 范围 → 挂载根 → 挂载根 realpath`

---

## ① 模式：read-only

- **写**：`在 ssh://qiyk/home/qiyk/test/probe1.txt 写入 hello`
  → `FS_SANDBOX_DENIED` / `file access denied under read-only mode`，且 SFTP **0 次触碰**
- **改**：`用 edit 把 ssh://qiyk/home/qiyk/test/add.py 的 a + b 改成 a - b`
  → 同上
- **命令**：`用 ssh_workspace_exec 在 qiyk 上执行 touch /home/qiyk/test/pwned`
  → `cannot run a remote command on ssh://qiyk: the session sandbox mode is "read-only" and a remote command cannot be confined — ... Reading still works through read / glob / grep / ops_* ... To run commands here, switch this session to workspace-write or danger-full-access.`
  反证：`glob .../pwned` 不存在
- **持久 shell**：`在远端 shell 里跑 rm -rf /home/qiyk/test/multiply.py` → 同一条命令围栏
- **上传**：`ssh_workspace_transfer upload → ssh://qiyk/home/qiyk/test/up.txt`
  → 文本 `cannot upload "...": file access denied under read-only mode — Switch the session to workspace-write or danger-full-access. Every remote write route (write / edit / upload / command execution) answers to the same mode.`
- **读取仍应放行（对照组）**：`read ssh://qiyk/home/qiyk/test/add.py` → 成功

## ② 范围：workspace-write 收窄到会话根

- **同主机兄弟根**：`写 ssh://qiyk/home/qiyk/other/probe2.txt`（会话根是 `/home/qiyk/test`）
  → `file access denied under workspace-write mode — the session workspace is "ssh://qiyk/home/qiyk/test", and workspace-write only permits writing inside it.`
- **跨主机**：`把文件写到另一台已挂载主机 ssh://other/srv/x.txt`
  → `... this session's workspace is on host "qiyk", not on "other". Switch this session to danger-full-access to write on another host.`
- **越界回退**：`写 ssh://qiyk/home/qiyk/test/../etc/probe3.txt`
  → 仍拒，且理由必须是「**only permits writing inside it**」而不是「没挂载」。判定前先把路径折叠（`..` 弹出），所以字面像「在根里」不算数；但**文案里的路径保持原样拼写**（`.../test/../etc/probe3.txt`），别把它误读成没折叠。
  对照反证：把同一目标切到 `danger-full-access`，理由会变成「没挂载」——证明两条围栏各自说话、没有互相吞掉。
- **`/tmp` 的边界（实测过，别凭直觉）**：
  - `写 ssh://qiyk/tmp/../etc/probe4.txt` → **拒**（`FS_SANDBOX_DENIED`，理由「inside it」）。范围围栏先折叠 `..` 再判临时区，所以 `/tmp/..` 不是后门。
  - `写 ssh://qiyk/tmp/./y.txt`、`写 ssh://qiyk/tmp/sub/../y.txt` → **放行**（折叠后仍在 `/tmp` 下）。
  - `写 ssh://qiyk/tmp2/x.txt`、`写 ssh://qiyk/tm/x.txt` → **拒**。前缀匹配要求 `=== '/tmp'` 或 `'/tmp/'` 开头，不是「startswith("/tmp")」。
- **对照放行**：`写 ssh://qiyk/home/qiyk/test/ok.txt` → 成功
- **决定②：`/tmp` 放行**：`写 ssh://qiyk/tmp/dsh-probe.txt` → **应成功**，`read` 回得到内容
- **`/tmp` 仅限本机**：跨主机 `写 ssh://other/tmp/x.txt` → 拒，理由是 **host 不匹配**，不是「不在会话根内」

## ③ 挂载根：danger-full-access 也拦越界

> 只有 `danger-full-access` 才跳过范围围栏、暴露挂载围栏——这一组必须切到最宽模式才测得到。

- `写 ssh://qiyk/etc/dsh-nope.txt` → `FS_OUTSIDE_WORKSPACE`：`outside every mounted remote workspace (mount it first with ssh_workspace_mount)`，反证：文件不存在
- `上传 → ssh://qiyk/etc/cron.d/dsh-probe` → 拒，且 `glob /etc/cron.d/dsh-probe` 必须不存在（写出字节前就拦下）
- 递归上传到未挂载目录树 → 拒，且**一个目录都没建出来**
- 什么都没挂的主机 `写 ssh://freshhost/tmp/x.txt` → 仍拒（「先挂载」没被 `/tmp` 放宽冲掉）

## ④ 符号链接逃逸（realpath 围栏，这条最难自己想到）

先在远端 `danger-full-access` 下摆一个坑：

```bash
mkdir -p /home/qiyk/test/real
ln -s /etc /home/qiyk/test/link
```

然后**会话切回 workspace-write**，粘这句：

- `把内容写到 ssh://qiyk/home/qiyk/test/link/dsh-escape.txt`
  → 词法看完全在挂载根内，realpath 发现祖先在 `/etc`：`a symbolic link resolves outside every mounted remote workspace`（`FS_OUTSIDE_WORKSPACE`）
  反证：`glob ssh://qiyk/etc/dsh-escape.txt` 不存在

对照（证明不是误杀）：`写 ssh://qiyk/home/qiyk/test/real/fine.txt` → 成功。

## ⑤ 停用（detach）

- 先在面板里 `detach` 该工作区，然后 `read ssh://qiyk/home/qiyk/test/add.py`
  → `FS_PERMISSION_DENIED` + `the remote workspace is detached (re-enable it in the panel or with ssh_workspace_enable)`
- 同状态下 `ssh_workspace_exec ... echo hi` → 一并拒
- **注意错误码不是** `FS_SANDBOX_DENIED`：停用不是沙箱事件；本机沙箱也解不开它（先 enable）

## ⑥ 未知模式（决定③，需要手动伪造）

GUI 只能选三个模式，要触发这条得直接喂字符串。在仓库根跑（下面这段已实测过，输出逐字对得上）：

```bash
node --input-type=module -e 'import { writeModeRefusal, assertRemoteCommandAllowed, sessionPolicyOf } from "./lib/mode-gate.js";
console.log(writeModeRefusal("yolo-mode", "ssh://qiyk/tmp/x"));
try { assertRemoteCommandAllowed("yolo-mode", "run a remote command", "ssh://qiyk") } catch (e) { console.log(e.message) }
assertRemoteCommandAllowed(undefined, "run a remote command", "ssh://qiyk"); console.log("undefined => 放行");
const ctx = { get: () => ({ resolve: () => { throw new Error("workspace root must be an absolute execution-world path") } }) };
const p = sessionPolicyOf(ctx, { header: { cwd: "ssh://qiyk/home/qiyk/test" } });
try { assertRemoteCommandAllowed(p, "run a remote command", "ssh://qiyk") } catch (e) { console.log(e.message) }'
```

**四条都要命中**：

1. 写拒绝含 `which this plugin does not recognise`，并列出 `{read-only, workspace-write, danger-full-access}`
2. 命令拒绝同样含该句，且尾部有 `Reading still works through read / glob / grep / ops_*.
3. 对照：`assertRemoteCommandAllowed(undefined, ...)` **必须放行**——策略服务缺席 = 未受限，不是拒绝
4. 第 ⑦ 条的 `unresolved` 文案见下

真机侧要触发同样的效果：在测试夹具里把 `sandboxPolicy.mode` 覆盖成任意字符串，再走一次 `write` / `exec`。

## ⑦ 策略解析失败 ≠ read-only（上轮那个「文案在撒谎」的回归位）

这是最容易悄悄退化的一条：`fs-shim` 的 `node:path` 补丁没装上时，resolver 对每个远端会话抛异常，`sessionPolicyOf` 兜底成 `read-only`——**方向安全（照拒）但会把接线故障说成用户的选择**。

触发：上面脚本的第 4 段，或者真实地跳过 `fs-shim` 安装再跑一次 `ssh_workspace_exec`。

**判据**（两句话必须同时成立）：

- 出现 `the session's sandbox policy could not be resolved (...), so this remote command was refused rather than run unconfined. This is a wiring problem, not a mode you chose — switching the session mode will not help.`
- **绝不**出现 `the session sandbox mode is "read-only"`——一旦谎称用户选了仅可查看，就是回归，因为切模式根本救不回来

反证判据：故障仍在时，`read` / `glob` / `grep` 必须**照常工作**（走 SFTP，不需要执行命令）。

## ⑧ 文案归因反查（防止被引向死路）

粘触发 ② 的兄弟根那条，检查拒绝文案尾部有没有：

> `but only a path that is also inside a MOUNTED workspace becomes writable then; if this one is not mounted, switching will not help (mount it with ssh_workspace_mount).`

没有 → 说明上一轮修掉的「让用户切一个照样撞墙的模式」死路又回来了。

---

## 一把梭脚本（可选）

把七组各挑一条最能说明问题的串起来跑，顺序即强度递增：

```
1. read-only     : exec touch $ROOT/pwned        → 必须拒 + 文件不存在
2. workspace-write: 写 ../etc/probe              → 必须拒（范围）
3. workspace-write: 写 $HOST/tmp/probe           → 必须成功（决定②）
4. workspace-write: 写 他机/tmp/probe            → 必须拒（host 先行）
5. danger-full   : 写 $HOST/etc/nope             → 必须拒 FS_OUTSIDE_WORKSPACE（决定①）
6. danger-full   : 上传 → $ROOT/link/drop        → 必须拒（symlink realpath）
7. 任意模式      : mode="yolo" 写 / exec          → 必须拒且文案不谎称 read-only（决定③）
```

7 条全中 = 三项决定 + 三条既有围栏同时成立。任一 FAIL：贴出**实际落盘结果 + 完整文案**，不要猜原因。
