/**
 * 云函数 csSend：消费 csOutbox 队列，把客服消息真正发出去（客服会话与私域引流 PRD）
 *
 * 为什么要有这个函数：
 *   微信要求「收到消息推送后 1 秒内返回」，而云函数 return 之后容器会被冻结、
 *   未完成的异步回调不保证执行完。发群码要先把云存储里的图片上传成临时素材换 media_id
 *   （几百 KB，几百毫秒起步），没法塞进 1 秒预算。所以 customer 只负责解析 + 入队，
 *   发送统一交给这个每分钟跑一次的定时触发器。
 *
 * 环境变量（与 customer 完全一致，复制一份过去）：
 *   MINI_APPID / MINI_APPSECRET
 *   R10 手机提醒渠道（三选一，与 customer 填一样的）：
 *     CS_SERVERCHAN_KEY / CS_PUSHPLUS_TOKEN / CS_WECOM_WEBHOOK
 *
 * 队列状态机：
 *   pending →（发送成功）sent
 *           →（失败且 retry < 3）pending + 指数退避（1min / 5min / 30min）
 *           →（失败且 retry >= 3）failed（静默，交给人工客服在「客服小助手」补回）
 */

const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const BUILD = '20261025-a1'

/**
 * 小程序名称（品牌名）
 * ⚠️ 与 utils/config.js 的 APP_NAME、cloudfunctions/customer 的同名常量保持一致
 */
const APP_NAME = '它的时光'

/** 单轮最多处理多少条（防单次执行超时） */
const LIMIT = 20
/** 最大重试次数 */
const MAX_RETRY = 3
/** 退避阶梯（毫秒） */
const BACKOFF = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000]

/**
 * 群码 = **普通微信群的入群二维码**
 * ⚠️ 不是企业微信群 —— 企业微信群只用于 R10 把通知推到你手机，用户看不到也进不去
 *
 * 说明文本存在云端 csConfig/group_intro，运营可改
 * ⚠️ 这是客服会话里的自动回复，可以出现「群」字；
 *    页面上的五个触点入口仍然一个字都不能提（PRD 附 D 红线）
 */
const GROUP_INTRO_DEFAULT = '群里可以问问题、晒它的照片，也会不定期分享养宠的东西。上面这张是入群二维码，长按识别就行。'

/** 云函数容器是 UTC，北京时间 = UTC + 8h */
function nowInChina() {
  return new Date(Date.now() + 8 * 3600 * 1000)
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function fmtChina(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = (c === 'x' ? r : (r & 0x3) | 0x8)
    return v.toString(16)
  })
}

/** 项目铁律：所有异步都要有超时兜底，否则 await 挂死会让整条链路看起来"点了没反应" */
function withTimeout(p, ms, tag) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + tag)), ms))
  ])
}

/**
 * 换 access_token
 * ⚠️ 与 cloudfunctions/customer/index.js、cloudfunctions/remind/index.js 三处是同一套实现
 *    （云函数之间无法共享代码文件），改一处记得同步另外两处。
 */
async function getAccessToken() {
  const ctx = cloud.getWXContext() || {}
  // ⚠️ 定时触发器场景下 getWXContext().APPID 为空：不兜底就会拿空 appid 换 token → 40013
  const appid = String(process.env.MINI_APPID || ctx.APPID || '').trim()
  const secret = String(process.env.MINI_APPSECRET || '').trim()
  if (!secret) throw new Error('缺少环境变量 MINI_APPSECRET')
  if (!appid) throw new Error('取不到 appid：请给 csSend 云函数配环境变量 MINI_APPID')

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
  const r = await axios.get(url, { timeout: 8000 })
  if (!r.data || !r.data.access_token) {
    console.error('[csSend] 换 token 失败 appid 尾号=', String(appid).slice(-4),
      '长度=', String(appid).length, '返回=', JSON.stringify(r.data))
    throw new Error('获取 access_token 失败: ' + JSON.stringify(r.data))
  }
  return r.data.access_token
}

/** 调客服消息接口下发（字段名一律下划线/小写：touser / msgtype / text.content） */
async function sendCustom(openid, msg, token) {
  let tk = token
  if (!tk) tk = await getAccessToken()
  const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${tk}`
  const r = await axios.post(url, Object.assign({ touser: openid }, msg), { timeout: 8000 })
  return r.data || {}
}

function sendText(openid, content, token) {
  return sendCustom(openid, { msgtype: 'text', text: { content } }, token)
}

async function findOne(col, where) {
  const r = await withTimeout(db.collection(col).where(where).limit(1).get(), 5000, 'find-' + col)
    .catch(() => null)
  return (r && r.data && r.data[0]) || null
}

/**
 * 消耗一条下发额度：先扣还没过期的窗口 E（进入会话 2 条/60s），再扣窗口 M（发消息 5 条/48h）
 * ⚠️ 不能用「覆盖」：用户 48h 窗口还剩 3 条时又进了会话，覆盖会让额度倒退成 2 条
 */
async function consume(openid) {
  const now = Date.now()
  const q = await findOne('csQuota', { openid })
  if (!q) return false
  if (q.eExp > now && q.eN > 0) {
    await withTimeout(
      db.collection('csQuota').doc(q._id).update({ data: { eN: q.eN - 1, updatedAt: db.serverDate() } }),
      5000, 'consume-e'
    ).catch(() => null)
    return true
  }
  if (q.mExp > now && q.mN > 0) {
    await withTimeout(
      db.collection('csQuota').doc(q._id).update({ data: { mN: q.mN - 1, updatedAt: db.serverDate() } }),
      5000, 'consume-m'
    ).catch(() => null)
    return true
  }
  return false
}

async function updateDoc(col, id, data) {
  await withTimeout(db.collection(col).doc(id).update({ data }), 5000, 'upd-' + col).catch((e) => {
    console.error('[csSend] 更新失败', col, id, e && e.message)
  })
}

async function addDoc(col, data) {
  return withTimeout(db.collection(col).add({ data }), 5000, 'add-' + col).catch((e) => {
    console.error('[csSend] 写入失败', col, e && e.message)
    return null
  })
}

async function trackEvent(openid, event, props) {
  await addDoc('events', {
    eventId: uuid(),
    event,
    props: props || {},
    anonId: '',
    sId: '',
    clientTs: Date.now(),
    appVer: '',
    baseLib: '',
    scene: 0,
    critical: false,
    openid,
    serverTs: db.serverDate()
  })
}

/**
 * 发群码：云存储取图 → 换临时素材 media_id → 发图片消息 + 说明文本（共 2 条）
 * ⚠️ media_id 绝不缓存：临时素材有时效，且运营换图后缓存会持续发旧图 —— 那正是 R4 要解决的问题
 */
async function sendGroupCode(openid, payload, token) {
  const fileID = payload && payload.fileID
  if (!fileID) throw new Error('未配置群码 fileID')
  const buf = await withTimeout(cloud.downloadFile({ fileID }), 10000, 'dl-group-code')
  const file = (buf && buf.fileContent) || buf
  const tk = token || await getAccessToken()
  const FormData = require('form-data')
  const form = new FormData()
  form.append('media', file, { filename: 'group.png', contentType: 'image/png' })
  const up = await axios.post(
    `https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${tk}&type=image`,
    form,
    { headers: form.getHeaders(), timeout: 15000, maxContentLength: Infinity, maxBodyLength: Infinity }
  )
  const mediaId = up.data && up.data.media_id
  if (!mediaId) throw new Error('上传素材失败: ' + JSON.stringify(up.data))

  if (!(await consume(openid))) throw new Error('无下发额度')
  const imgRes = await sendCustom(openid, { msgtype: 'image', image: { media_id: mediaId } }, tk)
  if (imgRes.errcode) throw new Error('发图片失败: ' + JSON.stringify(imgRes))

  const introCfg = await getConfig('group_intro', { text: GROUP_INTRO_DEFAULT })
  if (await consume(openid)) {
    const txtRes = await sendText(openid, introCfg.text || GROUP_INTRO_DEFAULT, tk)
    if (txtRes.errcode) console.error('[csSend] 群码说明文本发送失败', JSON.stringify(txtRes))
  } else {
    console.warn('[csSend] 图片已发出，说明文本无额度，降级只发图')
  }
  await trackEvent(openid, 'group_code_sent', {
    source: (payload && payload.source) || '',
    group: (payload && payload.group) || ''
  })
}

async function getConfig(id, fallback) {
  try {
    const r = await withTimeout(db.collection('csConfig').doc(id).get(), 5000, 'cfg-' + id)
    return (r && r.data) || fallback
  } catch (e) {
    return fallback
  }
}

/**
 * 重发 R10 的手机提醒（customer 同步推送失败时会入队到这里重试一次）
 * ⚠️ 走的是与 customer 同一套多渠道 dispatchNotify
 */
async function notifyOwner(payload) {
  const brief = (payload && payload.brief) || '[空消息]'
  // 标题带摘要（推送卡片只展示标题）；与 customer 的 notifyOwner 同一口径
  const title = `${APP_NAME} · ${String(brief).slice(0, 18)}`
  const body = [
    `来源：${(payload && payload.label) || '未知入口'}`,
    `宠物：${(payload && payload.who) || '未带宠物信息'}`,
    `内容：${brief}`,
    `时间：${fmtChina(nowInChina())}`
  ].join('\n')
  try {
    const kind = await dispatchNotify(title, body)
    if (kind === 'none') return
    console.log('[csSend] 提醒已推送 channel=' + kind)
  } catch (e) {
    console.error('[csSend] 提醒推送失败', e && e.message)
  }
}

/**
 * 按环境变量优先级选渠道推送，返回实际使用的渠道名；一个都没配返回 'none'
 * 优先级：Server 酱 Turbo → PushPlus → 企业微信机器人
 *
 * ⚠️ 这段代码与 cloudfunctions/customer/index.js 的 dispatchNotify 是同一份，
 *    云函数之间无法共享代码文件，改一处记得同步另一处。
 */
async function dispatchNotify(title, body) {
  // ① Server 酱 Turbo
  const sct = String(process.env.CS_SERVERCHAN_KEY || '').trim()
  if (sct) {
    const r = await axios.post(
      `https://sctapi.ftqq.com/${sct}.send`,
      { title, desp: body.split('\n').join('\n\n') },
      { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
    )
    if (!r.data || r.data.code !== 0) throw new Error('Server酱返回异常: ' + JSON.stringify(r.data))
    return 'serverchan'
  }

  // ② PushPlus
  const pp = String(process.env.CS_PUSHPLUS_TOKEN || '').trim()
  if (pp) {
    const r = await axios.post(
      'http://www.pushplus.plus/send',
      { token: pp, title, content: body, template: 'txt' },
      { timeout: 8000 }
    )
    if (!r.data || r.data.code !== 200) throw new Error('PushPlus返回异常: ' + JSON.stringify(r.data))
    return 'pushplus'
  }

  // ③ 企业微信群机器人
  const hook = String(process.env.CS_WECOM_WEBHOOK || '').trim()
  if (hook) {
    // ⚠️ 企微机器人字段名是 msgtype（不是 msgType），写错会静默失败
    const r = await axios.post(
      hook,
      { msgtype: 'text', text: { content: title + '\n' + body } },
      { timeout: 8000 }
    )
    if (!r.data || r.data.errcode) throw new Error('企微机器人返回异常: ' + JSON.stringify(r.data))
    return 'wecom'
  }

  return 'none'
}

async function handleItem(item, token) {
  const openid = item.openid
  try {
    if (item.kind === 'group_code') {
      await sendGroupCode(openid, item.payload, token)
    } else if (item.kind === 'welcome') {
      const cfg = await getConfig('welcome', { text: '' })
      if (!cfg.text) throw new Error('未配置欢迎语')
      if (!(await consume(openid))) throw new Error('无下发额度')
      const res = await sendText(openid, cfg.text, token)
      if (res.errcode) throw new Error('发欢迎语失败: ' + JSON.stringify(res))
      await trackEvent(openid, 'msg_sent', { source: (item.payload && item.payload.source) || '', kind: 'welcome' })
    } else if (item.kind === 'notify') {
      await notifyOwner(item.payload)
    }
    await updateDoc('csOutbox', item._id, { status: 'sent', sentAt: db.serverDate() })
    return 'sent'
  } catch (e) {
    const retry = (item.retry || 0) + 1
    console.error('[csSend] 发送失败 kind=' + item.kind, 'retry=' + retry, e && e.message)
    if (retry >= MAX_RETRY) {
      // 静默降级：不打扰用户，人工客服后续在「客服小助手」里补回
      await updateDoc('csOutbox', item._id, { status: 'failed', retry, lastErr: String((e && e.message) || e) })
      return 'failed'
    }
    await updateDoc('csOutbox', item._id, {
      status: 'pending',
      retry,
      nextTryAt: Date.now() + (BACKOFF[retry - 1] || BACKOFF[BACKOFF.length - 1]),
      lastErr: String((e && e.message) || e)
    })
    return 'retry'
  }
}

/** 清掉 7 天前的终态记录，避免集合无限膨胀 */
async function cleanup() {
  const before = Date.now() - 7 * 24 * 3600 * 1000
  await withTimeout(
    db.collection('csOutbox').where({ status: _.in(['sent', 'failed']), createdAt: _.lt(before) }).remove(),
    8000, 'cleanup'
  ).catch(() => null)
}

exports.main = async (event) => {
  event = event || {}
  const t0 = Date.now()

  if (event.diag) {
    return {
      ok: true,
      build: BUILD,
      pending: (await withTimeout(
        db.collection('csOutbox').where({ status: 'pending' }).count(), 5000, 'cnt'
      ).catch(() => ({ total: -1 }))).total,
      hasSecret: !!String(process.env.MINI_APPSECRET || '').trim(),
      hasAppid: !!String(process.env.MINI_APPID || '').trim(),
      notifyChannel: String(process.env.CS_SERVERCHAN_KEY || '').trim() ? 'serverchan'
        : String(process.env.CS_PUSHPLUS_TOKEN || '').trim() ? 'pushplus'
          : String(process.env.CS_WECOM_WEBHOOK || '').trim() ? 'wecom' : 'none'
    }
  }

  try {
    const now = Date.now()
    const r = await withTimeout(
      db.collection('csOutbox')
        .where({ status: 'pending', nextTryAt: _.lte(now) })
        .orderBy('createdAt', 'asc')
        .limit(LIMIT).get(),
      6000, 'scan'
    )
    const list = (r && r.data) || []
    if (!list.length) return { ok: true, scanned: 0, build: BUILD, cost: Date.now() - t0 }

    // 换一次 token 复用给整批：避免每条消息都打一次换 token 接口
    let token = ''
    try { token = await getAccessToken() } catch (e) {
      console.error('[csSend] 换 token 失败，本轮跳过', e && e.message)
      return { ok: false, err: e && e.message, build: BUILD, cost: Date.now() - t0 }
    }

    const stat = { sent: 0, retry: 0, failed: 0 }
    for (const item of list) {
      const r2 = await handleItem(item, token)
      stat[r2] = (stat[r2] || 0) + 1
    }

    // 顺手清一次终态记录（低频，失败无所谓）
    await cleanup()

    console.log('[csSend] 本轮完成', JSON.stringify(stat))
    return { ok: true, scanned: list.length, stat, build: BUILD, cost: Date.now() - t0 }
  } catch (e) {
    console.error('[csSend] 执行异常', e && e.message)
    return { ok: false, err: e && e.message, build: BUILD, cost: Date.now() - t0 }
  }
}
