/**
 * 埋点（PRD 第 9 节，不可砍）
 * 自建链路：前端队列 + storage 双写 → 批量调云函数 track → 白名单校验 → eventId 幂等写入
 *
 * 可靠性规则：
 * - flush 时机：满 10 条 / 距上次 30s / 切后台 / 冷启动
 * - 失败指数退避 1s / 5s / 30s 重试 3 次，仍失败留队列下次补发
 * - 队列上限 200，超限丢最旧「非关键」事件；关键事件永不丢弃
 * - 隐私：openid 仅云侧补齐；金额只报区间；不采集敏感字段
 */
const config = require('./config')

const QUEUE_KEY = 'tj_track_queue'
const ANON_KEY = 'tj_anon_id'
const SID_KEY = 'tj_sid'
const QUEUE_MAX = 200
const BATCH = 20
const FLUSH_AT = 10
const FLUSH_EVERY = 30 * 1000

/**
 * 关键事件：队列超限时永不丢弃（丢了下游看板会缺一整类数据）
 * ⚠️ agreement_agreed 是关键事件：它是「用户同意过协议」的唯一凭据，
 *    丢了之后合规举证就没有第二条线索了（storage 只在本机）
 */
const CRITICAL = ['pet_created', 'record_added', 'subscribe_requested', 'remind_pushed', 'agreement_agreed']

/** 事件白名单（与云函数侧一致）；二期补共享 6 事件 */
const WHITELIST = CRITICAL.concat([
  'app_launch', 'app_hide', 'pet_switched', 'pet_deleted',
  'daily_added', 'expense_added', 'share_image_generated',
  'page_view', 'sync_failed', 'track_dropped',
  // 二期共享宠物（PRD 第 8 节）
  'invite_created', 'invite_accepted', 'invite_failed',
  'member_removed', 'shared_record_added', 'shared_pet_viewed',
  // 客服会话与私域引流（PRD 附 B 第 7 条）
  'contact_opened', 'msg_sent', 'group_code_sent',
  // 时间线图文与相册（PRD v2.1 6.8）—— ⚠️ 必须与 cloudfunctions/track/index.js 同步，
  // 少改一边会被记成 track_dropped，看板上等于「没人发过图文」
  'post_added', 'photo_viewed', 'post_deleted', 'upload_failed',
  // 内容安全与风控（PRD《内容安全与风控》第 13 节）—— ⚠️ 同上，必须与云侧同步
  'sec_checked', 'content_reported', 'user_banned', 'appeal_submitted',
  // 设置页与协议合规（PRD《设置页与协议合规》）—— ⚠️ 同上，必须与云侧同步
  'agreement_agreed', 'cache_cleared',
  // 随手记自定义常用（PRD《随手记自定义常用》5）—— ⚠️ 同上，必须与云侧同步
  'daily_quick_configured',
  // 业务漏斗（运营数据看板）：填昵称/头像这一步 —— ⚠️ 必须与云侧同步
  'profile_updated'
])

let anonId = null
let sid = null
let lastFlushTs = 0
let retryTimer = null
let retryCount = 0

function genUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function getAnonId() {
  if (!anonId) {
    anonId = wx.getStorageSync(ANON_KEY)
    if (!anonId) {
      anonId = genUUID()
      wx.setStorageSync(ANON_KEY, anonId)
    }
  }
  return anonId
}

function getSid() {
  if (!sid) {
    sid = wx.getStorageSync(SID_KEY)
    const now = Date.now()
    // 超过 30 分钟视为新会话
    if (!sid || !sid.ts || now - sid.ts > 30 * 60 * 1000) {
      sid = { id: genUUID(), ts: now }
      wx.setStorageSync(SID_KEY, sid)
    }
    sid.ts = now
  }
  return sid.id
}

function getQueue() {
  try { return wx.getStorageSync(QUEUE_KEY) || [] } catch (e) { return [] }
}

function setQueue(q) {
  try { wx.setStorageSync(QUEUE_KEY, q) } catch (e) { /* 忽略 */ }
}

/** 金额区间（不存精确金额） */
function amountRange(yuan) {
  const v = Number(yuan) || 0
  if (v < 50) return '0-50'
  if (v < 200) return '50-200'
  if (v < 500) return '200-500'
  if (v < 2000) return '500-2000'
  return '2000+'
}

/**
 * 记录事件
 * @param {string} event 事件名（白名单）
 * @param {object} props 专属属性
 * @param {boolean} [critical] 是否关键事件（默认按名单判断）
 */
function track(event, props, critical) {
  if (WHITELIST.indexOf(event) === -1) {
    if (config.DEBUG) console.warn('[track] 未知事件被拒', event)
    return
  }
  const isCritical = critical !== undefined ? !!critical : CRITICAL.indexOf(event) > -1
  const evt = {
    eventId: genUUID(),
    event,
    props: props || {},
    anonId: getAnonId(),
    sId: getSid(),
    clientTs: Date.now(),
    appVer: config.VERSION,
    baseLib: wx.getAppBaseInfo ? (wx.getAppBaseInfo().SDKVersion || '') : '',
    scene: wx.getLaunchOptionsSync().scene || 0,
    critical: isCritical
  }
  // props 体积保护（≤2KB）
  if (JSON.stringify(evt.props).length > 2048) evt.props = { dropped: true }

  const q = getQueue()
  q.push(evt)
  // 超限丢最旧非关键
  while (q.length > QUEUE_MAX) {
    const i = q.findIndex((e) => !e.critical)
    q.splice(i === -1 ? 0 : i, 1)
  }
  setQueue(q)

  if (config.DEBUG) console.log('[track]', event, evt.props)

  if (q.length >= FLUSH_AT || Date.now() - lastFlushTs > FLUSH_EVERY) {
    flush()
  } else {
    scheduleFlush()
  }
}

function scheduleFlush() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    flush()
  }, FLUSH_EVERY)
}

/** 批量上报（批量 ≤ 20 条），失败指数退避 */
async function flush() {
  lastFlushTs = Date.now()
  let q = getQueue()
  if (!q.length || !wx.cloud) return
  const batch = q.slice(0, BATCH)
  try {
    await wx.cloud.callFunction({ name: 'track', data: { events: batch } })
    retryCount = 0
    q = getQueue()
    setQueue(q.slice(batch.length))
    if (getQueue().length) flush()
  } catch (e) {
    if (retryCount < 3) {
      const delays = [1000, 5000, 30000]
      setTimeout(() => { retryCount++; flush() }, delays[retryCount])
    }
    // 仍失败：留在队列，下次冷启动补发
  }
}

module.exports = {
  track,
  flush,
  amountRange,
  WHITELIST
}
