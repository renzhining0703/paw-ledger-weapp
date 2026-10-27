/**
 * 客服触点（客服会话与私域引流 PRD R1 / R6）
 *
 * 五个触点统一走 <button open-type="contact">，通过 session-from 把「来源 + 宠物信息」
 * 带给云函数 customer，云侧据此做多群分流（R5）与客服上下文展示（R6）。
 *
 * ⚠️ 红线（PRD 附 D）：页面上的触点文案绝不能出现「群 / 进群 / 福利 / 免费领」字样，
 *    只能说「问」「聊聊」「看看」这类服务性说法。
 *    （客服会话里的自动回复不受此限 —— 那是用户主动发起的 1:1 对话。）
 */
const config = require('./config')

/** session-from 的 source 取值（唯一数据源，云侧 group_map 与此对应） */
const SOURCES = {
  MINE: 'mine_ask',
  MILESTONE: 'milestone_birthday',
  SHARE: 'share_done',
  HEALTH: 'health_unknown',
  REMIND: 'remind_landing',
  /**
   * 举报（PRD v2.1 6.7 第 3 条：图文长按 → 举报 → 走已有客服会话）
   * ⚠️ 云侧 group_map 没有这个 key 时会回落 'A' 群（customer 的 `map[source] || 'A'`），
   *    不用为了举报单独配群码
   */
  REPORT: 'post_report',
  /**
   * 帮助与反馈页的「联系客服」（设置页与协议合规 PRD 2.1）
   * ⚠️ 云侧 group_map 没有这个 key 同样会回落 'A' 群，不用单独配群码
   */
  FEEDBACK: 'feedback_help'
}

/**
 * 频次规则：null = 不限；'week' = 每人每周 ≤1 次；'day' = 同日 ≤1 次
 * ⚠️ 触点 1（我的页）是静态入口，用户主动点进来，不限制
 * ⚠️ 触点 5（提醒落地）随提醒出现，也不限制
 */
const FREQ = {
  mine_ask: null,
  milestone_birthday: 'week',
  share_done: 'day',
  health_unknown: 'week',
  remind_landing: null,
  post_report: null,
  feedback_help: null
}

const GATE_KEY = 'tj_cs_gate_'

/**
 * 生成 session-from
 * 约定格式：src=mine_ask|pet=旺财|sp=dog（云侧 parseSessionFrom 与此对应）
 *
 * ⚠️ 宠物昵称必须先截断再 encode：昵称里可能有 emoji / 空格 / 特殊字符，
 *    且 session-from 过长会被微信截断，导致云侧解析出半个 key —— 解析容错兜得住，
 *    但归因就丢了。所以这里主动截到 8 个字符（emoji 按 1 个算会超，但解析仍成立）
 */
function sessionFrom(source, petName, species) {
  const name = String(petName || '').slice(0, 8)
  const sp = String(species || '').slice(0, 12)
  return `src=${source}|pet=${encodeURIComponent(name)}|sp=${encodeURIComponent(sp)}`
}

/** 本周一 00:00 的时间戳（周级锚点，周一为一周起点） */
function weekAnchor() {
  const d = new Date()
  const wd = d.getDay() === 0 ? 7 : d.getDay()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - wd + 1)
  return d.getTime()
}

/** 今天 00:00 的时间戳（日级锚点） */
function dayAnchor() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 判断触点本次能否展示；能展示则顺手占位（写入锚点）
 *
 * ⚠️ 这是「消耗型」判断，调一次就吃掉这一周/这一天的名额。
 *    所以只在真正要渲染前调一次，不要在 onLoad / onShow 里提前探测。
 */
function canShow(source) {
  const rule = FREQ[source]
  if (!rule) return true
  const anchor = rule === 'week' ? weekAnchor() : dayAnchor()
  let last = 0
  try { last = Number(wx.getStorageSync(GATE_KEY + source) || 0) } catch (e) { last = 0 }
  if (last >= anchor) return false
  try { wx.setStorageSync(GATE_KEY + source, anchor) } catch (e) { /* 忽略 */ }
  return true
}

/**
 * 只判断不占位
 *
 * ⚠️ 为什么要有 peek / canShow 两个方法：
 *    页面的 refresh() 会被 onShow、下拉刷新、数据同步等反复触发，而 canShow 是消耗型的
 *    —— 第一次调用写锚点后，第二次调用就返回 false。如果直接在 refresh 里用 canShow，
 *    触点会在第二次刷新时莫名消失。
 *
 * 正确用法（页面里）：
 *    const on = 条件满足 && (this._shown || CS.peek(src))
 *    if (on) { this._shown = true; CS.canShow(src) }   // 只在真正展示那一次占位
 *    页面重新进入时 _shown 丢失，本周已被 canShow 占位 → peek 返回 false → 不再展示
 */
function peek(source) {
  const rule = FREQ[source]
  if (!rule) return true
  const anchor = rule === 'week' ? weekAnchor() : dayAnchor()
  let last = 0
  try { last = Number(wx.getStorageSync(GATE_KEY + source) || 0) } catch (e) { last = 0 }
  return last < anchor
}

/** 今天是否与该日期「月日相同」（生日判定） */
function isTodayMD(dateStr) {
  const p = String(dateStr || '').split('-')
  if (p.length !== 3) return false
  const d = new Date()
  return Number(p[1]) === d.getMonth() + 1 && Number(p[2]) === d.getDate()
}

/**
 * 今天是否是「到家周年」（满一整年起）
 * ⚠️ 到家日当天不算周年 —— 那是第 0 年，文案「到家一周年」会名不副实
 */
function isAnniversary(dateStr) {
  const p = String(dateStr || '').split('-')
  if (p.length !== 3) return false
  const d = new Date()
  if (Number(p[1]) !== d.getMonth() + 1 || Number(p[2]) !== d.getDate()) return false
  return d.getFullYear() > Number(p[0])
}

module.exports = {
  SOURCES,
  FREQ,
  sessionFrom,
  canShow,
  peek,
  isTodayMD,
  isAnniversary
}
