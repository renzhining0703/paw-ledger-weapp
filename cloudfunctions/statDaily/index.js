/**
 * 云函数 statDaily：日活 / 业务漏斗日聚合（每天 01:10 定时跑）
 *
 * 为什么必须有这一步：
 *   events 只保留 90 天且每月清理，量大、聚合慢；看板（csAdmin 的 dailyStats action）
 *   的历史数据全部来自本函数产出的 dailyStats 集合 —— 一天一条，永久保留。
 *
 * 调用方式：
 *   1. 定时触发器（config.json 每天 01:10）→ 自动统计「昨天」
 *   2. 手动补算：传 { date: '2026-10-26' } 统计指定某天（events 有 90 天，可回补）
 *
 * 口径（⚠️ 全部按**北京时间**自然日切分，serverTs 在库里是 UTC ——
 *       按 UTC 切的话中国用户晚上 8 点的打开会被记到「明天」，已踩过的坑别再踩）：
 *   dau            当天有任意事件的 openid 去重数
 *   newUsers       app_launch 且 props.isFirst = true 的人数
 *   launches       app_launch 事件条数（冷启动次数）
 *   sessions       当天 sId 去重数（30 分钟内算同一次使用）
 *   profileUpdated profile_updated 事件的人数（填了昵称/头像）
 *   petsCreated    pet_created 事件的人数
 *   recordsAdded   record_added / daily_added / expense_added 任一的人数
 *   postsAdded     post_added 事件的人数
 *
 * ⚠️ 同源约定：聚合口径与 cloudfunctions/csAdmin/index.js 的 dailyStats 实时统计
 *    是同一份逻辑的两份拷贝（云函数之间无法共享代码文件）—— 改口径两处一起改。
 *    （同款先例：FAQ 规则、事件白名单也都是双份维护。）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

const COL_EVENTS = 'events'
const COL_STATS = 'dailyStats'

const RECORD_EVENTS = ['record_added', 'daily_added', 'expense_added']

/** 北京时间 dateStr（YYYY-MM-DD）→ 该自然日的 UTC 起止 Date */
function dayRange(dateStr) {
  const p = String(dateStr || '').split('-').map(Number)
  const start = Date.UTC(p[0], p[1] - 1, p[2], 0, 0, 0) - 8 * 3600 * 1000
  return { start: new Date(start), end: new Date(start + 86400000) }
}

/** 当前时刻对应的北京时间日期串（YYYY-MM-DD） */
function cstTodayStr(now) {
  return new Date((now || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 人数口径的通用管道：按时间区间 + 事件过滤 → 按 openid 去重计数 */
async function countUsers(range, extraMatch) {
  const r = await db.collection(COL_EVENTS).aggregate()
    .match(Object.assign({ serverTs: _.gte(range.start).and(_.lt(range.end)) }, extraMatch || {}))
    .group({ _id: '$openid' })
    .count('n')
    .end()
  return (r.list && r.list[0] && r.list[0].n) || 0
}

/** 条数口径：按时间区间 + 事件过滤 → 文档条数 */
async function countDocs(range, extraMatch) {
  const r = await db.collection(COL_EVENTS)
    .where(Object.assign({ serverTs: _.gte(range.start).and(_.lt(range.end)) }, extraMatch || {}))
    .count()
  return r.total || 0
}

/** 一天的完整统计（供定时任务与补算共用） */
async function statOneDay(dateStr) {
  const range = dayRange(dateStr)

  const dau = await countUsers(range)
  const launches = await countDocs(range, { event: 'app_launch' })
  const [newUsers, profileUpdated, petsCreated, recordsAdded, postsAdded] = await Promise.all([
    countUsers(range, { event: 'app_launch', 'props.isFirst': true }),
    countUsers(range, { event: 'profile_updated' }),
    countUsers(range, { event: 'pet_created' }),
    countUsers(range, { event: _.in(RECORD_EVENTS) }),
    countUsers(range, { event: 'post_added' })
  ])

  // sessions：sId 去重（不能复用 countUsers 的 openid 分组，单独跑一条管道）
  const sr = await db.collection(COL_EVENTS).aggregate()
    .match({ serverTs: _.gte(range.start).and(_.lt(range.end)), event: 'app_launch' })
    .group({ _id: '$sId' })
    .count('n')
    .end()
  const sessionCount = (sr.list && sr.list[0] && sr.list[0].n) || 0

  return {
    date: dateStr,
    dau, newUsers, launches,
    sessions: sessionCount,
    profileUpdated, petsCreated, recordsAdded, postsAdded
  }
}

/** 幂等写入：同一天重跑覆盖旧值（补算 / 手动重跑都安全） */
async function saveStats(stats) {
  const ex = await db.collection(COL_STATS).where({ date: stats.date }).limit(1).get()
  if (ex.data && ex.data.length) {
    await db.collection(COL_STATS).doc(ex.data[0]._id).update({ data: Object.assign(stats, { statAt: db.serverDate() }) })
    return 'updated'
  }
  await db.collection(COL_STATS).add({ data: Object.assign(stats, { statAt: db.serverDate() }) })
  return 'added'
}

exports.main = async (event) => {
  // 定时触发器：统计「昨天」（01:10 跑时昨天已完整）
  if (event && (event.Type === 'Timer' || event.triggerName)) {
    const yest = cstTodayStr(Date.now() - 24 * 3600 * 1000)
    const stats = await statOneDay(yest)
    const r = await saveStats(stats)
    return { ok: true, date: yest, saved: r }
  }

  // 手动补算：{ date: 'YYYY-MM-DD' }；不传 date = 统计今天（截止当前时刻，非全天）
  const dateStr = String((event && event.date) || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { ok: false, err: '传 { date: "YYYY-MM-DD" } 指定要补算的日期' }
  }
  const stats = await statOneDay(dateStr)
  const r = await saveStats(stats)
  return { ok: true, date: dateStr, saved: r, stats }
}
