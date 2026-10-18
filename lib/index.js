/**
 * DSH remote-workspace plugin — host half.
 *
 * Publishes a `ctx.fs` that serves ordinary host paths from the deployment's
 * own (sandboxed) local backend and `ssh://<alias>/<abs-path>` targets over
 * SFTP, so a folder on a remote machine can be registered as a DSH workspace
 * and used by the ordinary file tools. The Host's own builtin calls for the
 * same targets — `node:fs/promises` operations and `node:path` spellings —
 * are bridged too (see fs-shim.js), because creating a session and attaching
 * it to its workspace happen before any agent exists. Commands against a
 * remote workspace travel through the two execution seams, both patched onto
 * the live services: `ctx.shell` for the pwsh/bash tools (patch-shell.js) and
 * `ctx.subprocess` for the file tools' helpers — remote glob/grep via
 * ripgrep, and change tracking via git (patch-subprocess.js).
 *
 * Agent tools: ssh_workspace_hosts, ssh_workspace_mount, ssh_workspace_unmount,
 * ssh_workspace_status, ssh_workspace_exec, ssh_workspace_forward,
 * ssh_workspace_unforward.
 *
 * @module @shiqyka/dsh-ssh-workspace
 */

import { SshWorkspaceEngine } from './engine.js'
import { RemoteFileSystem } from './remote-fs.js'
import { ForwardManager } from './forward.js'
import { SavedForwardManager } from './forward-persist.js'
import { ShellManager } from './shell.js'
import { installRemoteFileSystem, uninstallRemoteFileSystem } from './patch-fs.js'
import { installRemoteShell, uninstallRemoteShell } from './patch-shell.js'
import { installRemoteSubprocess, uninstallRemoteSubprocess } from './patch-subprocess.js'
import { installRemoteSandbox, uninstallRemoteSandbox } from './patch-sandbox.js'
import { installRemoteTerminal, uninstallRemoteTerminal } from './patch-terminal.js'
import { installBuiltinBridge, uninstallBuiltinBridge } from './fs-shim.js'
import { isRemotePath, parseRemotePath } from './protocol.js'
import { createRemoteSkillProvider } from './remote-skills.js'
import { workspaceTools } from './tools.js'
import { makeRoutes } from './routes.js'

/** Stable Cordis plugin name. */
export const name = 'ssh-workspace'

/**
 * Services required before the surfaces can mount.
 *
 * Note `fs` is deliberately NOT listed here: a profile applies its patch layer
 * after its bundles, so the filesystem backend may not exist yet at plugin
 * load. It is injected on the service BODY instead (see {@link apply}), which
 * runs as soon as the backend appears and re-runs across reloads.
 *
 * `systemPrompt` (agent guidance) is optional and read with `ctx.get()`, so a
 * deployment without it still activates. `webServer` is optional too: the HTTP
 * routes for the browser half wait for it in a second injection, so the plugin
 * is equally usable headless (agent tools only) and in the Web GUI.
 */
export const inject = ['tools']

/** Relative order of the announcement section inside the tool-guidance band. */
const SECTION_ORDER = 155

/** Model-facing announcement describing the remote-workspace capability. */
export const SSH_WORKSPACE_GUIDANCE = [
  '本机已安装 dsh-ssh-workspace 插件（远程工作区）：可以把一台 SSH 主机上的目录当作 DSH 工作区使用。',
  '',
  '工作区路径语法：`ssh://<主机别名>/<远端绝对路径>`，例如 `ssh://myserver/home/user/project`。',
  '当会话工作区是这种路径时，read / write / edit 会通过 SFTP 直接读写远端文件，无需手动同步。',
  '',
  '工具：ssh_workspace_hosts（列出主机）、ssh_workspace_mount（挂载远端目录为工作区）、',
  'ssh_workspace_unmount（注销）、ssh_workspace_status（查看当前状态）、ssh_workspace_exec（在远端执行命令）、',
  'ssh_workspace_transfer（本机与远端之间传文件，不经对话内容）、',
  'ssh_workspace_forward / ssh_workspace_unforward（把远端端口映射到本机 / 关闭映射）。',
  '主机列表在「远程工作区」面板中管理（添加 / 编辑 / 删除），写入 $DSH_HOME/dsh-ssh.json；~/.ssh/config 为只读回退。',
  '',
  '远端工作区的能力与限制（重要）：',
  '- read / write / edit / glob / grep 都在远端生效：glob / grep 会调用远端主机上的 ripgrep（rg）搜索远端内容，',
  '  返回的是远端路径；远端未安装 rg 时会得到明确的安装提示（退出码 127）。',
  '- 工作区变更追踪（diff / 变更面板）使用远端 git，需要远端主机安装 git；未安装时该功能自动关闭。',
  '- 远端变更监视（文件树 / 预览自动刷新）优先使用远端 inotifywait 推送事件（即时、不受 mtime 精度限制）；',
  '  未安装时回退到轮询（约 2 秒一次，同一秒内等长的连续改写可能不触发刷新）。',
  '- 端口转发：ssh_workspace_forward 把远端端口映射到本机（例如远端 dev server 的 5173），返回可打开的',
  '  http://localhost:<port> 地址；映射随 SSH 连接存活，连接断开即自动关闭，可再次调用重新打开；',
  '  ssh_workspace_unforward 主动关闭并释放本地端口。注意远端应用可能有自己的 host / 回调白名单校验',
  '  （如 Vite 的 server.allowedHosts、Next 的 allowedDevOrigins、OAuth 的 redirect URI），需要一并放行 localhost。',
  '- 会话工作区是 ssh:// 时，pwsh / bash 工具的 workdir 会落到远端，命令在远端主机上以 POSIX shell（bash/sh）语义执行；',
  '  请按远端环境写命令（如 ls / cat / grep，而非 PowerShell 的 Get-ChildItem / Get-Content / Select-String）。',
  '- 远端命令不受本机文件沙箱约束，以远端登录用户的完整权限运行；本机沙箱策略（sandbox_permissions）不适用于远端命令。',
  '- 大文件读取按块流式传输（预览 / read 不会把整个文件读进内存）；写入采用「暂存文件 + 原子替换」。',
  '- 写入范围限制在已挂载的远端工作区内。',
  '',
  'run_code（PTC 模式）与技能（重要）：',
  '- run_code 的程序运行在本机的一个私有临时目录里：process.cwd() 不是远端路径，',
  '  node:fs 也读不到远端文件。要访问远端工作区文件，请通过 PTC 绑定调用 read / write / edit /',
  '  glob / grep 这些工具（它们已走 SFTP 落到远端）；只有纯本地临时文件才用 node:fs。',
  '- 远端工作区的项目技能（<工作区>/.dsh/skills、<工作区>/.agents/skills）由本插件直接发现，',
  '  会出现在会话技能目录里，可直接调用；新增或修改后无需重启即可被下一轮感知。',
].join('\n')

/**
 * Mount the SSH workspace engine, the `ctx.fs` router, and the agent tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} [config] - resolved plugin config.
 * @param {boolean} [config.enabled] - master switch (default true).
 * @param {boolean} [config.announceToAgent] - add the system-prompt section.
 * @param {object} [config.engine] - connection tuning overrides:
 *   `idleTimeoutMs`, `connectTimeoutMs`, `keepaliveIntervalMs`,
 *   `sweepIntervalMs` (see {@link SshWorkspaceEngine}).
 * @returns {void}
 */
export function apply (ctx, config = {}) {
  if (config.enabled === false) return

  const engine = new SshWorkspaceEngine({ logger: ctx.logger, ...(config.engine ?? {}) })
  // The detached-workspace list is loaded up front, not in the registry
  // injection below: the shell, subprocess and terminal halves never wait for
  // the registry, and a workspace that stays runnable until a later activation
  // step would be "off" only in the file panel.
  let detachedWorkspaces = []
  try {
    detachedWorkspaces = engine.store.entryStore.workspaces().disabled
    engine.setDisabledWorkspaces(detachedWorkspaces)
  } catch (error) {
    ctx.logger?.warn?.(`ssh-workspace: could not read the detached-workspace list: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Secrets written by older versions sit in the shared store as plaintext;
  // move them into the encrypted section once, best-effort, so a store this
  // plugin cannot understand is left alone instead of clobbered.
  try {
    const encrypted = engine.store.entryStore.encryptStoredSecrets()
    if (encrypted > 0) {
      ctx.logger?.info?.(`ssh-workspace: encrypted ${encrypted} host secret(s) that were still stored in plaintext`)
    }
  } catch (error) {
    ctx.logger?.warn?.(`ssh-workspace: could not encrypt stored host secrets: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Local listeners mapped to remote ports ride the pooled connections; their
  // lifecycle follows the engine (see forward.js). The saved half sits on top:
  // the store holds which mappings the user wants, and this manager joins that
  // intent onto the listeners that actually exist.
  const forwards = new ForwardManager({ engine, logger: ctx.logger })
  const savedForwards = new SavedForwardManager({ forwards, store: engine.store.entryStore, logger: ctx.logger })
  forwards.onClosed = (entry, reason) => { savedForwards.noteClosed(entry, reason) }
  // Persistent remote shells hold their own connections and keep their state;
  // they close with the plugin.
  const shells = new ShellManager({ engine, logger: ctx.logger })

  // Register system prompt guidance if requested and available
  if (config.announceToAgent === true) {
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt) {
        ctx.effect(
          () => systemPrompt.section({
            name: 'plugin:dsh-ssh-workspace',
            order: SECTION_ORDER,
            text: SSH_WORKSPACE_GUIDANCE,
          }),
          'ssh-workspace: guidance',
        )
      }
    } catch {
      // systemPrompt not available, skip guidance
    }
  }

  /**
   * The router installed onto the live `ctx.fs`, shared with the route half.
   *
   * @type {import('./remote-fs.js').RemoteFileSystem | undefined}
   */
  let router

  /**
   * Take over the live `ctx.fs` once it exists.
   *
   * @param {import('@deepseek-ai/cordis').Context} scoped - the context the
   *   injected service body runs in (owns the effects below).
   * @returns {void}
   */
  const install = (scoped) => {
    // The deployment already mounted its own local backend under this name, so
    // the remote methods are installed onto that ONE live instance rather than
    // re-provided (Cordis refuses a second provide('fs')).
    router = installRemoteFileSystem(scoped, { engine }, RemoteFileSystem)
    if (router === undefined) {
      scoped.logger?.warn?.('ssh-workspace: ctx.fs was not available; the remote workspace cannot be served')
      return
    }
    engine.attachFileSystem(router)

    // The Host's own builtin calls do not travel through `ctx.fs`, and several
    // run on a new session's cwd before its agent exists — the Session
    // controller's `mkdir`, the Workspace registry's `realpath`/`stat`, and the
    // Session service's `path.isAbsolute` header check — so both builtins are
    // bridged for `ssh://` targets too.
    installBuiltinBridge({ engine, router, logger: scoped.logger })

    scoped.effect(() => () => {
      // Drop the patch before the engine goes away so a late call cannot reach a
      // disposed connection pool; shells and forwards close first among the
      // engine's consumers so their channels are gone before the connections drop.
      uninstallBuiltinBridge()
      uninstallRemoteFileSystem(scoped.get('fs'))
      shells.dispose()
      forwards.dispose()
      engine.dispose()
    }, 'ssh-workspace: fs patch')

    scoped.effect(
      () => {
        const installed = workspaceTools(ctx, engine, router, forwards, shells).map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of installed) dispose() }
      },
      'ssh-workspace: tools',
    )
  }

  // Opening saved tunnels at startup is opt-in (the `autoStart` preference in
  // the store, written by the panel). It runs on a later tick and never throws:
  // an unreachable host must not delay or fail the plugin's own activation, and
  // a mapping that cannot bind is reported in the panel like any other failure
  // rather than taking the profile down.
  const startSavedForwards = () => {
    setTimeout(() => {
      savedForwards.autoStart().catch((error) => {
        ctx.logger?.warn?.(`ssh-workspace: could not auto-open saved port forwards: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 0)
  }
  startSavedForwards()

  // `ctx.inject` runs `install` immediately when `fs` is already available and
  // otherwise as soon as it is provided — which is what makes the takeover
  // independent of where this plugin sits relative to the backend in the
  // profile's entry list.
  ctx.inject(['fs'], install)

  // The shell seam allows ONE executor per context and the deployment's local
  // executor is already mounted, so the remote half is installed onto that
  // live instance too (see patch-shell.js): a spec whose workdir is an
  // `ssh://` target runs on the host, everything else through the original
  // local executor unchanged.
  ctx.inject(['shell'], (scoped) => {
    const shellRouter = installRemoteShell(scoped, { engine, logger: scoped.logger })
    if (shellRouter === undefined) {
      scoped.logger?.warn?.('ssh-workspace: ctx.shell was not available; remote command execution is disabled')
      return
    }
    scoped.effect(() => () => { uninstallRemoteShell(scoped.get('shell')) }, 'ssh-workspace: shell patch')
  })

  // The file tools' helpers spawn short-lived child processes through
  // ctx.subprocess, and two of them can legitimately carry a remote workspace
  // as cwd — the search tool's ripgrep and the change tracker's git. The
  // remote half is installed onto that live service the same way (see
  // patch-subprocess.js): specs whose cwd is an `ssh://` target run on the
  // remote machine, everything else through the original spawn unchanged.
  ctx.inject(['subprocess'], (scoped) => {
    const subprocessRouter = installRemoteSubprocess(scoped, { engine, logger: scoped.logger })
    if (subprocessRouter === undefined) {
      scoped.logger?.warn?.('ssh-workspace: ctx.subprocess was not available; remote glob/grep and git support are disabled')
      return
    }
    scoped.effect(() => () => { uninstallRemoteSubprocess(scoped.get('subprocess')) }, 'ssh-workspace: subprocess patch')
  })

  // A persistent terminal is the same seam one layer up: the harness's terminal
  // backend asks `ctx.subprocess.spawnTerminal` for a PTY, which is a LOCAL
  // primitive. Without this, a persistent shell whose cwd is an ssh:// workspace
  // either fails or starts a local shell against a path that only exists on the
  // host. Installing here makes the harness's own terminal tools work remotely.
  ctx.inject(['subprocess'], (scoped) => {
    const terminalRouter = installRemoteTerminal(scoped, { engine, logger: scoped.logger })
    if (terminalRouter === undefined) {
      scoped.logger?.warn?.('ssh-workspace: ctx.subprocess was not available; remote terminals are disabled')
      return
    }
    scoped.effect(() => () => { uninstallRemoteTerminal(scoped.get('subprocess')) }, 'ssh-workspace: terminal patch')
  })

  // A `run_code` (PTC) child is spawned LOCALLY on a remote workspace — the
  // runtime derives its file policy from the session's standing policy, whose
  // workspace root is the `ssh://` spelling. A local sandbox backend cannot
  // confine a process to a directory that only exists on another machine, so
  // the remote root is substituted with the same private scratch directory the
  // subprocess bridge uses (see patch-sandbox.js and ptc-local.js).
  ctx.inject(['sandbox'], (scoped) => {
    const sandboxRouter = installRemoteSandbox(scoped, { logger: scoped.logger })
    if (sandboxRouter === undefined) {
      scoped.logger?.warn?.('ssh-workspace: ctx.sandbox was not available; run_code keeps its local file policy')
      return
    }
    scoped.effect(() => () => { uninstallRemoteSandbox(scoped.get('sandbox')) }, 'ssh-workspace: sandbox patch')
  })

  // The served-root set lives in memory while the workspace registration is
  // durable, so without this a restart would leave ssh:// workspaces listed in
  // the UI but unserved — and their writes fenced off. Re-mount whatever the
  // registry still lists; like the route injection below, this also installs
  // the patch itself when it happens to activate first.
  ctx.inject(['fs', 'workspaceRegistry'], (scoped) => {
    const activeRouter = router ?? installRemoteFileSystem(scoped, { engine }, RemoteFileSystem)
    if (activeRouter === undefined) return
    const registry = scoped.get('workspaceRegistry')
    if (typeof registry?.list !== 'function') return
    // Workspaces the user detached: their registration survives so the row
    // stays visible and re-enableable, but the plugin must NOT re-mount them —
    // that would make "off" last only until the next restart.
    const detached = detachedWorkspaces
    const detachedSet = new Set(detached)
    let restored = 0
    for (const entity of registry.list()) {
      const path = String(entity?.path ?? '')
      if (!isRemotePath(path)) continue
      if (detachedSet.has(path)) continue
      try {
        const parts = parseRemotePath(path)
        activeRouter.addRoot(parts.alias, parts.remotePath)
        restored += 1
      } catch (error) {
        scoped.logger?.warn?.(`ssh-workspace: could not re-mount "${path}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (restored > 0) scoped.logger?.info?.(`ssh-workspace: re-mounted ${restored} remote workspace(s) from the registry`)
    if (detachedSet.size > 0) scoped.logger?.info?.(`ssh-workspace: ${detachedSet.size} detached remote workspace(s) left unserved`)
  })

  // Remote project skills. The deployment's own filesystem skill provider
  // discovers skills with `node:fs`, which cannot open an `ssh://` target, so a
  // remote workspace contributes no skills at all — they never reach the model
  // catalog and cannot be loaded. This provider answers the same catalog
  // questions over the patched `ctx.fs`, which already routes remote targets
  // over SFTP. Optional: a deployment without the skill registry simply keeps
  // the filesystem-only behavior.
  if (config.skills?.enabled !== false) {
    ctx.inject(['fs', 'skills'], (scoped) => {
      const skills = scoped.get('skills')
      if (skills === undefined || skills === null || typeof skills.registerProvider !== 'function') return
      // The fs injection normally runs first; installing through the router is
      // idempotent, so this also covers the reverse activation order.
      const activeRouter = router ?? installRemoteFileSystem(scoped, { engine }, RemoteFileSystem)
      if (activeRouter === undefined) return
      scoped.effect(
        () => {
          let provider
          const disposeProvider = skills.registerProvider((control) => {
            provider = createRemoteSkillProvider({
              fs: scoped.get('fs'),
              cwd: '',
              logger: scoped.logger,
              watch: config.skills?.watch !== false,
              invalidate: control.invalidate,
              signal: control.signal,
            })
            return provider
          })
          return async () => {
            disposeProvider()
            await provider?.dispose?.()
          }
        },
        'ssh-workspace: remote skills',
      )
    })
  }

  // The browser half. Its routes need BOTH the filesystem (to mount through)  // and the deployment's web server, and either may appear after this plugin
  // loads — so wait for both instead of giving up on a first look. A deployment
  // without a web server simply never gets the HTTP surface, while the agent
  // tools above still work.
  ctx.inject(['fs', 'webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined || webServer === null) return
    // The fs injection normally got here first; installing is idempotent, so
    // this also covers the reverse activation order.
    const activeRouter = router ?? installRemoteFileSystem(scoped, { engine }, RemoteFileSystem)
    if (activeRouter === undefined) return
    scoped.effect(
      () => {
        const routes = makeRoutes({ engine, router: activeRouter, forwards, savedForwards, shells, ctx: scoped })
        const disposers = routes.map(route => webServer.register(route))
        scoped.logger?.info?.(`ssh-workspace: registered ${routes.length} HTTP routes for the browser half`)
        return () => { for (const dispose of disposers) dispose() }
      },
      'ssh-workspace: routes',
    )
  })
}

export { SshWorkspaceEngine, RemoteFileSystem }
export { formatRemotePath, parseRemotePath, isRemotePath, normalizeRemotePath } from './protocol.js'
