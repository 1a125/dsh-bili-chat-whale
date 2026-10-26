import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 统一路径。
 *
 * 为什么所有东西都从这里取：宿主半边（lib/index.js，运行在 DSH 里）和工具链
 * （tools/*.mjs，被 agent / 宿主 spawn 成独立 node 进程）必须看同一份配置、同一份状态。
 * 两边各自拼路径，迟早会分叉（尤其 DSH_HOME 被自定义、多 profile 的时候）。
 */
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** 与 DSH 宿主一致的 DSH home 解析顺序。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** 插件自己的数据目录（状态、日志、模型、临时片段都在这里）。 */
export const DATA_DIR = path.join(DSH_HOME, 'chat-whale')

export const CONFIG_PATH = process.env.CHAT_WHALE_CONFIG || path.join(DSH_HOME, 'bili-chat-whale.config.json')
export const STATE_PATH = path.join(DATA_DIR, 'state.json')
export const ACTIVITY_PATH = path.join(DATA_DIR, 'activity.jsonl')
export const CONTROL_PATH = path.join(DATA_DIR, 'control.json')
export const BAN_PATH = path.join(DATA_DIR, 'api-ban.json')
export const SESSION_PATH = path.join(DATA_DIR, 'session.json')
export const ROOMS_DIR = path.join(DATA_DIR, 'rooms')
export const TMP_DIR = path.join(DATA_DIR, 'tmp')
export const ASR_DIR = path.join(DATA_DIR, 'asr')
export const ASR_MODEL_DIR = path.join(ASR_DIR, 'sensevoice')
export const LOG_DIR = path.join(DATA_DIR, 'logs')
export const HOST_LOG_PATH = path.join(LOG_DIR, 'host.log')

/**
 * 专属会话的工作区 —— 也是 agent 的沙箱工作区。
 *
 * 为什么要在这里放一个 .chat-whale/ 指令队列：
 *   agent 的 pwsh 工具跑在 workspace-write 沙箱里，写不了 <DSH_HOME>/chat-whale/
 *   （state / 日志都在那儿）→ 直接调 CLI 会 EPERM，然后 agent 去申请完全访问，
 *   就变成每条弹幕都要主人点一次批准 ✗
 *   所以 CLI 只往工作区里的 inbox 放一个请求，宿主（不受沙箱限制）执行并回执。
 */
export const WORK_DIR = path.join(DSH_HOME, 'chat-whale-work')
export const BRIDGE_DIR = path.join(WORK_DIR, '.chat-whale')
export const BRIDGE_INBOX = path.join(BRIDGE_DIR, 'inbox')
export const BRIDGE_OUTBOX = path.join(BRIDGE_DIR, 'outbox')
export const BRIDGE_FILE = path.join(BRIDGE_DIR, 'bridge.json')

/** B 站登录态。默认与「养鱼」插件共用同一个账号文件，扫码一次两边都能用。 */
export const CREDENTIALS_PATH = path.join(HOME, '.bili-ai', 'credentials.json')

/** 插件根目录与工具链脚本位置（被宿主的 child_process 调用的那些）。 */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const TOOLS_ROOT = path.join(PLUGIN_ROOT, 'tools')
export const CLI_PATH = path.join(TOOLS_ROOT, 'chat-whale.mjs')
export const ASR_WORKER_PATH = path.join(TOOLS_ROOT, 'asr', 'worker.mjs')

export const dshPath = (...parts) => path.join(DSH_HOME, ...parts)
export const dataPath = (...parts) => path.join(DATA_DIR, ...parts)
