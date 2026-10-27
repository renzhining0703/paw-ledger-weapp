/**
 * 云函数 track：埋点落库 + 月度数据清理（PRD 第 9 节）
 *
 * 调用方式：
 * 1. 前端批量上报：{ events: [...] } → 白名单校验 → 补 openid/serverTs → eventId 幂等写入
 * 2. 定时触发器（每月）：清理 90 天前的过期事件
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 事件白名单：未知事件直接拒绝（防脏数据污染看板）；二期补共享 6 事件 */
const WHITELIST = [
  'app_launch', 'app_hide', 'pet_created', 'pet_switched', 'pet_deleted',
  'record_added', 'daily_added', 'expense_added', 'share_image_generated',
  'subscribe_requested', 'remind_pushed', 'page_view', 'sync_failed',
  'invite_created', 'invite_accepted', 'invite_failed',
  'member_removed', 'shared_record_added', 'shared_pet_viewed',
  // 客服会话与私域引流（PRD 附 B 第 7 条）
  'contact_opened', 'msg_sent', 'group_code_sent',
  // 时间线图文与相册（PRD v2.1 6.8）—— 与前端 utils/track.js 白名单必须一致
  'post_added', 'photo_viewed', 'post_deleted', 'upload_failed',
  // 内容安全与风控（PRD《内容安全与风控》第 13 节）—— 与前端 utils/track.js 必须一致
  'sec_checked', 'content_reported', 'user_banned', 'appeal_submitted',
  // 设置页与协议合规（PRD《设置页与协议合规》）—— 与前端 utils/track.js 必须一致
  'agreement_agreed', 'cache_cleared',
  // 随手记自定义常用（PRD《随手记自定义常用》5）—— 与前端 utils/track.js 必须一致
  'daily_quick_configured',
  // 业务漏斗（运营数据看板）：填昵称/头像这一步 —— 与前端 utils/track.js 必须一致
  'profile_updated'
]

/** 敏感字段黑名单：事件属性里出现即剔除 */
const SENSITIVE_KEYS = ['phone', 'mobile', 'location', 'latitude', 'longitude', 'amount', 'precision']

const RETENTION_DAYS = 90

function sanitizeProps(props) {
  const out = {}
  Object.keys(props || {}).forEach((k) => {
    if (SENSITIVE_KEYS.indexOf(k) === -1) out[k] = props[k]
  })
  return out
}

async function handleBatch(events, openid) {
  let accepted = 0
  for (const evt of (events || []).slice(0, 20)) {
    if (!evt || !evt.eventId || WHITELIST.indexOf(evt.event) === -1) {
      // 未知事件名：记一条 track_dropped
      await safeAdd({
        event: 'track_dropped',
        props: { reason: 'unknown-event', raw: evt && evt.event },
        anonId: (evt && evt.anonId) || '',
        sId: (evt && evt.sId) || '',
        clientTs: (evt && evt.clientTs) || 0,
        openid
      })
      continue
    }
    const ok = await safeAdd({
      eventId: evt.eventId, // events 集合需为 eventId 建唯一索引 → 幂等去重
      event: evt.event,
      props: sanitizeProps(evt.props),
      anonId: evt.anonId || '',
      sId: evt.sId || '',
      clientTs: evt.clientTs || 0,
      appVer: evt.appVer || '',
      baseLib: evt.baseLib || '',
      scene: evt.scene || 0,
      critical: !!evt.critical,
      openid
    })
    if (ok) accepted++
  }
  return { accepted }
}

async function safeAdd(doc) {
  try {
    doc.serverTs = db.serverDate()
    await db.collection('events').add({ data: doc })
    return true
  } catch (e) {
    // eventId 重复等错误：幂等忽略
    return false
  }
}

/** 保留期 90 天：删除超期事件（每月定时触发） */
async function cleanup() {
  const deadline = new Date(Date.now() - RETENTION_DAYS * 86400000)
  let removed = 0
  for (;;) {
    const r = await db.collection('events')
      .where({ serverTs: _.lt(deadline) })
      .limit(100)
      .get()
    if (!r.data.length) break
    await Promise.all(r.data.map((d) => db.collection('events').doc(d._id).remove()))
    removed += r.data.length
    if (r.data.length < 100) break
  }
  return { removed }
}

exports.main = async (event) => {
  // 定时触发器入口（cloudfunctions/track/config.json 配置每月执行）
  if (event && (event.Type === 'Timer' || event.triggerName)) {
    return cleanup()
  }
  const { OPENID } = cloud.getWXContext()
  return handleBatch(event.events, OPENID)
}
