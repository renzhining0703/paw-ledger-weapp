/**
 * 云函数 customer：接收微信客服消息推送（客服会话与私域引流 PRD）
 *
 * 配置路径（上线前必做，缺一步消息就到不了这里）：
 *   云开发控制台 → 设置 → 其他设置 → 消息推送 → 推送模式选「云函数」→ 指定 customer
 *   ⚠️ 同时必须关掉「在官方客服工作台收发消息」—— 不关的话消息根本不会推到云函数
 *
 * 环境变量（云函数 → 配置 → 环境变量）：
 *   MINI_APPID        小程序 AppID
 *   MINI_APPSECRET    小程序 AppSecret（与 remind 云函数填同一个值）
 *   R10 手机提醒渠道（三选一，配哪个用哪个；都不配就跳过，不影响其它逻辑）：
 *     CS_SERVERCHAN_KEY  Server 酱 Turbo 的 SendKey → 直接推到你的个人微信（不需要企业微信）
 *     CS_PUSHPLUS_TOKEN  PushPlus 的 token         → 同上
 *     CS_WECOM_WEBHOOK   企业微信群机器人 webhook   → 需要企业微信内部群
 *
 * 硬约束（违反会白干半天）：
 *   1. 必须 1 秒内返回。云函数 return 后容器会被冻结，未完成的异步回调不保证执行完，
 *      所以「要上传素材换 media_id」的回复一律入队 csOutbox，交给 csSend 定时触发器发；
 *      本函数只做纯文本这类「一次 cgi 就能发完」的快路径。
 *   2. 任何异常都吞掉并返回成功。给微信返错只会让它重试 3 次，用户侧看到的是消息发不出去。
 *   3. 云函数（管理端）写入不会自动注入 _openid，按用户维度查的集合必须显式写。
 *      （本项目已在 subTickets 上踩过：查不到自己刚写的数据）
 *
 * 配额模型（PRD 5.1）：
 *   用户发送信息   → 可下发 5 条 / 48 小时
 *   用户进入会话   → 可下发 2 条 / 1 分钟
 *   条数不累加，每次动作刷新额度。
 *   ⚠️ 实现上不能用「覆盖」：用户在 48h 窗口还剩 3 条时又进了会话（2 条/1 分钟），
 *      覆盖会让额度倒退成 2 条。所以维护两个独立窗口，发送时先消耗还没过期的临时窗口。
 */
const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const BUILD = '20261025-a1'

/**
 * 小程序名称（品牌名）
 * ⚠️ 云函数无法 require 前端的 utils/config.js，这里的值与 utils/config.js 的 APP_NAME 保持一致
 */
const APP_NAME = '它的时光'

/** 进入会话窗口：2 条 / 60 秒 */
const WIN_ENTER_N = 2
const WIN_ENTER_MS = 60 * 1000
/** 用户发消息窗口：5 条 / 48 小时 */
const WIN_MSG_N = 5
const WIN_MSG_MS = 48 * 60 * 60 * 1000
/** 会话归因有效期：24 小时 */
const SESSION_MS = 24 * 60 * 60 * 1000

/** 默认欢迎语（云端 csConfig/welcome 可覆盖，改文案不用发版） */
const WELCOME_DEFAULT = [
  '你好，我是店长。养宠的问题直接问就行，我看到就回。',
  '想和同样在记录的人聊聊的话，回复「群」。'
].join('\n')

/** 非工作时间默认应答（云端 csConfig/hours 可覆盖） */
const AFTER_HOURS_DEFAULT = '这会儿我不在线，看到就回你。急的话先描述一下它的情况，我明早一早处理。'

/** 默认工作时段（北京时间，含头不含尾） */
const HOURS_DEFAULT = { start: 9, end: 22 }

/**
 * 触点 → 群 的默认映射（云端 csConfig/group_map 的 `map` 字段可覆盖）
 * ⚠️ 与 cloudfunctions/csAdmin/index.js 的 GROUP_MAP_DEFAULT 保持一致
 */
const GROUP_MAP_DEFAULT = {
  mine_ask: 'A',
  milestone_birthday: 'B',
  share_done: 'C',
  health_unknown: 'A',
  remind_landing: 'A'
}

/**
 * 默认 FAQ 规则（R7；云端 csConfig/faq 可覆盖）
 * ⚠️ 顺序即优先级，取第一条命中的规则。
 * ⚠️ 红线只约束「页面文案」：客服会话是用户主动发起的 1:1 对话，回复里可以出现「群」字。
 *    但页面上的五个触点入口仍然一个字都不能提（PRD 附 D）。
 */
const FAQ_DEFAULT = [
  { keys: ['群', '进群', '加群', '社群', '交流', '组织'], kind: 'group_code' },
  {
    keys: ['疫苗', '打针', '接种', '三联', '狂犬', '第几针'],
    kind: 'text',
    text: '猫狗常规是：幼年期猫三联/犬四联打 3 针（每针间隔 21 天），之后每年加强 1 针；狂犬满 3 月龄就能打，之后每年 1 针。具体以医院为准 —— 你在「健康」页记一针，下次到期前一天会自动提醒你。'
  },
  {
    keys: ['驱虫', '体内', '体外', '多久', '频率', '拜宠清'],
    kind: 'text',
    text: '常规节奏：体内 3 个月一次，体外 1 个月一次（夏天或常出门可以加密到 3 周）。药不用固定一种，轮换着用反而更好。在「健康」页记一次，到期会自动提醒。'
  },
  {
    keys: ['异宠', '守宫', '蛇', '龟', '仓鼠', '兔', '鸟', '蜜袋鼯'],
    kind: 'text',
    text: '异宠基本没有常规疫苗要打（守宫、蛇、龟、仓鼠都不需要），重点是环境：温度梯度、湿度、垫材和食物单一性。你说一下物种和现在的状态，我帮你看哪里可以调。'
  }
]

/** 触点中文名（R10 转发时展示，来源字段是英文 key） */
const SRC_LABEL = {
  mine_ask: '我的页 · 养宠问题',
  milestone_birthday: '首页 · 生日/到家周年',
  share_done: '长图成功页',
  health_unknown: '健康页 · 空态',
  remind_landing: '到期提醒落地页'
}

/** 云函数容器是 UTC，北京时间 = UTC + 8h */
function nowInChina() {
  return new Date(Date.now() + 8 * 3600 * 1000)
}

function hourInChina() {
  return nowInChina().getUTCHours()
}

/**
 * 消息摘要（留痕与通知共用同一口径，避免两处截断长度不一致）
 * ⚠️ 只截 30 字，且绝不带 openid —— 运营后台和手机通知都只看这个
 */
function briefOf(mt, text) {
  if (mt === 'image') return '[图片]'
  return String(text || '').slice(0, 30) || '[空消息]'
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

/**
 * ⚠️ 项目铁律：所有异步都要有超时兜底。
 * 真机上 db / axios 存在既不 success 也不 fail 的情况，await 挂死会让整条链路"点了没反应"。
 */
function withTimeout(p, ms, tag) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + tag)), ms))
  ])
}

/**
 * 用 appid + secret 换 access_token
 * ⚠️ 与 cloudfunctions/remind/index.js 的 getAccessToken 是同一套实现（云函数间无法共享代码文件），
 *    改这里记得同步改那边。
 * ⚠️ 不用 cloud.openapi.customerServiceMessage：本项目是个人主体，云调用会报 -501001，
 *    必须自换 token + HTTPS 调 cgi-bin（remind 的 subscribeMessage.send 已验证同款坑）。
 */
async function getAccessToken() {
  const ctx = cloud.getWXContext() || {}
  // ⚠️ 定时触发器 / 云端手动测试这类非用户调用场景下 getWXContext().APPID 可能是空的，
  //    空 appid 换 token → 微信回 40013 invalid appid。用环境变量兜底。
  const appid = String(process.env.MINI_APPID || ctx.APPID || '').trim()
  const secret = String(process.env.MINI_APPSECRET || '').trim()
  if (!secret) throw new Error('缺少环境变量 MINI_APPSECRET')
  if (!appid) throw new Error('取不到 appid：请给 customer 云函数配环境变量 MINI_APPID')

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
  const r = await axios.get(url, { timeout: 8000 })
  if (!r.data || !r.data.access_token) {
    console.error('[customer] 换 token 失败 appid 尾号=', String(appid).slice(-4),
      '长度=', String(appid).length, '返回=', JSON.stringify(r.data))
    throw new Error('获取 access_token 失败: ' + JSON.stringify(r.data))
  }
  return r.data.access_token
}

/**
 * 解析 session-from
 * 约定格式：src=mine_ask|pet=旺财|sp=dog
 * ⚠️ 必须容错：用户从微信「小程序客服消息」盒子再次进来时这段是空的，
 *    解析不出就用默认值，绝不能让解析异常阻断后面的消息处理。
 */
function parseSessionFrom(s) {
  const out = { source: '', petName: '', species: '' }
  try {
    String(s || '').split('|').forEach((seg) => {
      const i = seg.indexOf('=')
      if (i < 0) return
      const k = seg.slice(0, i).trim()
      const v = seg.slice(i + 1).trim()
      if (k === 'src' && v) out.source = v
      else if (k === 'pet' && v) out.petName = decodeURIComponent(v)
      else if (k === 'sp' && v) out.species = v
    })
  } catch (e) {
    console.warn('[customer] session-from 解析失败，回落默认', s)
  }
  return out
}

/** 读云端配置，读不到用默认值（配置缺失不能让客服变哑巴） */
async function getConfig(id, fallback) {
  try {
    const r = await withTimeout(db.collection('csConfig').doc(id).get(), 5000, 'cfg-' + id)
    return (r && r.data) || fallback
  } catch (e) {
    return fallback
  }
}

async function findOne(col, where) {
  const r = await withTimeout(db.collection(col).where(where).limit(1).get(), 5000, 'find-' + col)
    .catch(() => null)
  return (r && r.data && r.data[0]) || null
}

async function updateDoc(col, id, data) {
  await withTimeout(db.collection(col).doc(id).update({ data }), 5000, 'upd-' + col).catch((e) => {
    console.error('[customer] 更新失败', col, id, e && e.message)
  })
}

async function addDoc(col, data) {
  return withTimeout(db.collection(col).add({ data }), 5000, 'add-' + col).catch((e) => {
    console.error('[customer] 写入失败', col, e && e.message)
    return null
  })
}

/**
 * 更新会话归因账本
 * ⚠️ source 只在「这次消息真的带了 SessionFrom」时才覆盖。
 *    用户从微信会话列表的聚合盒子再次进来时没有 SessionFrom，
 *    这时沿用上次的归因 —— 否则 R5 的多群归因会大面积丢失。
 */
async function touchSession(openid, sf) {
  const now = Date.now()
  const prev = await findOne('csSessions', { openid })
  const patch = {
    _openid: openid,
    openid,
    lastEnterAt: now,
    expireAt: now + SESSION_MS,
    updatedAt: db.serverDate()
  }
  if (prev) {
    if (sf.source) {
      patch.source = sf.source
      patch.petName = sf.petName
      patch.species = sf.species
    }
    await updateDoc('csSessions', prev._id, patch)
    return Object.assign({}, prev, patch)
  }
  Object.assign(patch, {
    source: sf.source || 'mine_ask',
    petName: sf.petName || '',
    species: sf.species || '',
    welcomedAt: 0,
    afterHoursAt: 0
  })
  // ⚠️ 必须把新建文档的 _id 带回去：welcomedAt / afterHoursAt 的幂等更新依赖它，
  //    拿不到 _id 会导致「每次进入会话都重发欢迎语」（刷屏）
  const r = await addDoc('csSessions', patch)
  return Object.assign({ _id: (r && r._id) || '' }, patch)
}

/** 刷新配额：进入会话 → 窗口 E；用户发消息 → 窗口 M */
async function upsertQuota(openid, patch) {
  const prev = await findOne('csQuota', { openid })
  patch._openid = openid
  patch.openid = openid
  patch.updatedAt = db.serverDate()
  if (prev) return updateDoc('csQuota', prev._id, patch)
  return addDoc('csQuota', patch)
}

async function refreshEnter(openid) {
  const now = Date.now()
  await upsertQuota(openid, { eN: WIN_ENTER_N, eExp: now + WIN_ENTER_MS })
}

async function refreshMsg(openid) {
  const now = Date.now()
  await upsertQuota(openid, { mN: WIN_MSG_N, mExp: now + WIN_MSG_MS })
}

/**
 * 消耗一条下发额度：先扣还没过期的窗口 E，再扣窗口 M
 * @returns {Promise<boolean>} 是否拿到额度（false = 静默降级，不打扰用户）
 */
async function consume(openid) {
  const now = Date.now()
  const q = await findOne('csQuota', { openid })
  if (!q) return false
  if (q.eExp > now && q.eN > 0) {
    await updateDoc('csQuota', q._id, { eN: q.eN - 1, updatedAt: db.serverDate() })
    return true
  }
  if (q.mExp > now && q.mN > 0) {
    await updateDoc('csQuota', q._id, { mN: q.mN - 1, updatedAt: db.serverDate() })
    return true
  }
  return false
}

/**
 * 调客服消息接口下发
 * ⚠️ 微信 cgi-bin 系列接口的 JSON 字段一律下划线/小写：touser / msgtype / text.content。
 *    写成驼峰（msgType）微信收不到 → 报 40007 之类。
 */
async function sendCustom(openid, msg) {
  const token = await getAccessToken()
  const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`
  const r = await axios.post(url, Object.assign({ touser: openid }, msg), { timeout: 8000 })
  return r.data || {}
}

function sendText(openid, content) {
  return sendCustom(openid, { msgtype: 'text', text: { content } })
}

/**
 * 发群码：云存储取图 → 换临时素材 media_id → 发图片消息
 * ⚠️ media_id 绝不缓存：临时素材有时效，且运营换图后缓存会持续发旧图 —— 那正好是 R4 要解决的问题。
 */
async function sendGroupImage(openid, fileID) {
  const buf = await withTimeout(cloud.downloadFile({ fileID }), 10000, 'dl')
  const file = (buf && buf.fileContent) || buf
  const token = await getAccessToken()
  const FormData = require('form-data')
  const form = new FormData()
  form.append('media', file, { filename: 'group.png', contentType: 'image/png' })
  const up = await axios.post(
    `https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=image`,
    form,
    { headers: form.getHeaders(), timeout: 15000, maxContentLength: Infinity, maxBodyLength: Infinity }
  )
  const mediaId = up.data && up.data.media_id
  if (!mediaId) throw new Error('上传素材失败: ' + JSON.stringify(up.data))
  return sendCustom(openid, { msgtype: 'image', image: { media_id: mediaId } })
}

/**
 * 命中 FAQ 规则（顺序优先，包含匹配）
 * 规则优先读云端 csConfig/faq（运营可改话术不用发版），读不到才用内置默认
 */
async function matchRule(text) {
  const cfg = await getConfig('faq', null)
  const rules = (cfg && cfg.rules && cfg.rules.length) ? cfg.rules : FAQ_DEFAULT
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]
    for (let j = 0; j < r.keys.length; j++) {
      if (text.indexOf(r.keys[j]) !== -1) return r
    }
  }
  return null
}

/** 埋点：云函数侧直接写 events 集合（前端队列走不到这里） */
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
 * 发欢迎语（幂等：24h 内只发一次）
 *
 * 两条入口共用：
 *   ① 进入会话事件（正常路径）
 *   ② 用户首条消息（兜底，见 handleUserMsg —— event 推送规则漏配时就靠这条）
 */
async function maybeWelcome(openid, sess) {
  const now = Date.now()
  // 「每次会话只发一次」：24h 内发过就不再发，用户反复进出不会刷屏
  if (sess.welcomedAt && now - sess.welcomedAt < SESSION_MS) {
    console.log('[customer] 24h 内已发过欢迎语，跳过')
    return false
  }
  const cfg = await getConfig('welcome', { text: WELCOME_DEFAULT })
  const text = cfg.text || WELCOME_DEFAULT
  if (!(await consume(openid))) {
    console.warn('[customer] 无下发额度，欢迎语静默降级')
    return false
  }
  const res = await sendText(openid, text)
  if (res.errcode) {
    console.error('[customer] 欢迎语发送失败', JSON.stringify(res))
    return false
  }
  if (sess._id) {
    await updateDoc('csSessions', sess._id, { welcomedAt: now })
  }
  return true
}

async function handleEnter(openid, sf) {
  const sess = await touchSession(openid, sf)
  await refreshEnter(openid)
  await maybeWelcome(openid, sess)
}

async function handleUserMsg(openid, mt, sf, raw) {
  const sess = await touchSession(openid, sf)
  await refreshMsg(openid)

  const text = String(raw || '').trim()
  const brief = briefOf(mt, text)

  /**
   * 消息留痕
   * ⚠️ 关掉「在官方客服工作台收发消息」之后，微信侧（工作台 / 客服小助手）
   *    都看不到用户说了什么，这是运营唯一能看到内容的途径，不能省。
   */
  await addDoc('csMessages', {
    _openid: openid,
    openid,
    dir: 'in', // in = 用户发的，out = 运营回的
    msgType: mt,
    content: brief,
    source: sess.source || '',
    createdAt: db.serverDate()
  })
  if (sess._id) {
    // 会话摘要：运营后台的会话列表直接读这三个字段，不用去聚合 csMessages
    await updateDoc('csSessions', sess._id, {
      lastMsg: brief,
      lastAt: Date.now(),
      unread: _.inc(1)
    })
  }

  /**
   * 欢迎语兜底：正常靠「进入会话」事件（MsgType=event）触发，
   * 但云开发「消息推送」要按消息类型分条配置，event 那条极易漏配 ——
   * 漏了就永远收不到进入会话、欢迎语永远发不出去，而且没有任何报错。
   * 所以在用户第一次开口时补一次，保证这条链路不漏。
   *
   * 幂等靠 sess.welcomedAt：正常走事件时它已被写入，这里不会再发。
   */
  if (!sess.welcomedAt) {
    console.log('[customer] 会话未发过欢迎语，在用户首条消息时补发')
    await maybeWelcome(openid, sess)
  }

  // R9 非工作时间：先暖场一条，再走正常自动回复（两条都发，48h 窗口有 5 条，够）
  const hours = await getConfig('hours', { start: HOURS_DEFAULT.start, end: HOURS_DEFAULT.end, text: AFTER_HOURS_DEFAULT })
  const h = hourInChina()
  const working = h >= Number(hours.start) && h < Number(hours.end)
  if (!working) {
    const now = Date.now()
    if (!sess.afterHoursAt || now - sess.afterHoursAt >= SESSION_MS) {
      if (await consume(openid)) {
        const res = await sendText(openid, hours.text || AFTER_HOURS_DEFAULT)
        if (res.errcode) console.error('[customer] 非工作时间应答发送失败', JSON.stringify(res))
        else if (sess._id) await updateDoc('csSessions', sess._id, { afterHoursAt: now })
      }
    }
  }

  if (mt === 'text' && text) {
    const rule = await matchRule(text)
    if (!rule) {
      console.log('[customer] 未命中 FAQ，转人工')
    } else if (rule.kind === 'group_code') {
      // 慢路径：入队，由 csSend 上传素材后发（本函数必须在 1s 内返回）
      /**
       * ⚠️ 已修 bug：csConfig/group_map 这个文档的形状是
       *      { _id:'group_map', map:{ mine_ask:'A', ... }, updatedAt }
       *    map 在 **doc.map** 里，不是文档本身。
       *    原来写成 `gmap[sess.source]` → 恒为 undefined → 永远落到 'A' 群：
       *    ① R5 的多群归因直接失效；② 只配了 B / C 群码时，用户回复「群」什么都收不到。
       */
      const gm = await getConfig('group_map', null)
      const map = (gm && gm.map) || GROUP_MAP_DEFAULT
      const codes = (await getConfig('group_code', {})) || {}
      let gkey = map[sess.source] || 'A'
      // 目标群没配码 → 落到第一个配了码的群，别让「回复群」石沉大海
      if (!(codes[gkey] && codes[gkey].fileID)) {
        gkey = ['A', 'B', 'C'].filter((g) => codes[g] && codes[g].fileID)[0] || gkey
      }
      const fileID = codes[gkey] && codes[gkey].fileID
      console.log('[customer] 群码归因 source=', sess.source, 'group=', gkey, 'hasCode=', !!fileID)
      await addDoc('csOutbox', {
        _openid: openid,
        openid,
        kind: 'group_code',
        payload: { fileID, group: gkey, source: sess.source },
        status: fileID ? 'pending' : 'failed',
        retry: 0,
        nextTryAt: Date.now(),
        createdAt: db.serverDate()
      })
    } else {
      if (await consume(openid)) {
        const res = await sendText(openid, rule.text)
        if (res.errcode) console.error('[customer] FAQ 回复发送失败', JSON.stringify(res))
        else await trackEvent(openid, 'msg_sent', { source: sess.source, kind: 'faq' })
      }
    }
  }

  // R10 把「有人来问了」推到手机（只带上下文，绝不转发用户全文 / openid）
  await notifyOwner(sess, mt, text)
}

async function notifyOwner(sess, mt, text) {
  const label = SRC_LABEL[sess.source] || sess.source || '未知入口'
  const who = sess.petName ? `${sess.petName}${sess.species ? '（' + sess.species + '）' : ''}` : '未带宠物信息'
  const brief = briefOf(mt, text)
  /**
   * 标题必须带摘要：PushPlus / Server 酱 的推送卡片只展示标题，
   * 正文要再点「查看详情」才看得到。标题若只写「有人来问了」，
   * 手机上根本判断不出这人问的是什么，等于白推。
   * 标题上限 32 字（Server 酱），摘要截 18 字留出品牌名前缀的余量。
   */
  const title = `${APP_NAME} · ${brief.slice(0, 18)}`
  const body = [
    `来源：${label}`,
    `宠物：${who}`,
    `内容：${brief}`,
    `时间：${fmtChina(nowInChina())}`
  ].join('\n')
  const payload = { label, who, brief }
  let failed = false
  try {
    const kind = await dispatchNotify(title, body)
    // 'none' = 压根没配渠道，本来就不该提醒，不当作失败
    if (kind === 'none') return
    console.log('[customer] 提醒已推送 channel=' + kind)
  } catch (e) {
    failed = true
    // ⚠️ 推送失败不影响主链路：用户该收到的自动回复已经在前面发完了
    console.error('[customer] 提醒推送失败', e && e.message)
  }
  if (!failed) return
  // 渠道配了但推送没成功 → 入队，交给 csSend 一分钟后再试一次
  await addDoc('csOutbox', {
    _openid: '',
    openid: '',
    kind: 'notify',
    payload,
    status: 'pending',
    retry: 0,
    nextTryAt: Date.now() + 60 * 1000,
    createdAt: db.serverDate()
  })
}

/**
 * 按环境变量优先级选渠道推送，返回实际使用的渠道名；一个都没配返回 'none'
 *
 * 为什么要提供好几条渠道：
 *   企业微信要是已经加入了公司组织，在公司企微里建自己业务的群既不合适（公私混用），
 *   外部群又加不了群机器人。Server 酱 / PushPlus 这类是「关注他们的服务号 + 拿个 key」，
 *   消息直接落在你平时用的微信里，不需要任何额外的企业微信身份。
 *
 * ⚠️ 这段代码与 cloudfunctions/csSend/index.js 的 dispatchNotify 是同一份，
 *    云函数之间无法共享代码文件，改一处记得同步另一处。
 */
async function dispatchNotify(title, body) {
  // ① Server 酱 Turbo：https://sctapi.ftqq.com/{SendKey}.send
  const sct = String(process.env.CS_SERVERCHAN_KEY || '').trim()
  if (sct) {
    const r = await axios.post(
      `https://sctapi.ftqq.com/${sct}.send`,
      // desp 支持 Markdown，连续换行才能分段，直接 \n 会被折成一行
      { title, desp: body.split('\n').join('\n\n') },
      { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
    )
    if (!r.data || r.data.code !== 0) throw new Error('Server酱返回异常: ' + JSON.stringify(r.data))
    return 'serverchan'
  }

  // ② PushPlus：http://www.pushplus.plus/send
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

/** 诊断分支：返回云端配置快照，排障用（不影响正常消息处理） */
async function diag() {
  const [gmap, codes, welcome, hours] = await Promise.all([
    getConfig('group_map', null),
    getConfig('group_code', null),
    getConfig('welcome', null),
    getConfig('hours', null)
  ])
  return {
    ok: true,
    build: BUILD,
    group_map: gmap,
    group_code: codes,
    welcome: welcome,
    hours: hours,
    hasSecret: !!String(process.env.MINI_APPSECRET || '').trim(),
    hasAppid: !!String(process.env.MINI_APPID || '').trim(),
    // 实际会走哪条提醒渠道（serverchan / pushplus / wecom / none）
    notifyChannel: notifyChannel()
  }
}

/** 当前生效的手机提醒渠道（用于 diag 自检） */
function notifyChannel() {
  if (String(process.env.CS_SERVERCHAN_KEY || '').trim()) return 'serverchan'
  if (String(process.env.CS_PUSHPLUS_TOKEN || '').trim()) return 'pushplus'
  if (String(process.env.CS_WECOM_WEBHOOK || '').trim()) return 'wecom'
  return 'none'
}

exports.main = async (event) => {
  event = event || {}
  const t0 = Date.now()
  console.log('[customer] build =', BUILD, 'MsgType =', event.MsgType, 'Event =', event.Event || '-')

  if (event.diag) return diag()

  try {
    const openid = String(event.FromUserName || '').trim()
    if (!openid) {
      console.warn('[customer] 消息缺少 FromUserName，忽略')
      return { errcode: 0, errmsg: 'success' }
    }
    const mt = event.MsgType
    if (mt === 'event') {
      if (event.Event === 'user_enter_tempsession') {
        await handleEnter(openid, parseSessionFrom(event.SessionFrom))
      }
      return { errcode: 0, errmsg: 'success', build: BUILD, cost: Date.now() - t0 }
    }
    if (mt === 'text' || mt === 'image') {
      await handleUserMsg(openid, mt, parseSessionFrom(event.SessionFrom), event.Content)
      return { errcode: 0, errmsg: 'success', build: BUILD, cost: Date.now() - t0 }
    }
    console.log('[customer] 未处理类型', mt)
    return { errcode: 0, errmsg: 'success', build: BUILD, cost: Date.now() - t0 }
  } catch (e) {
    // ⚠️ 仍然返回成功：给微信返错 = 重试 3 次，用户侧只看到消息发不出去
    console.error('[customer] 处理异常（已吞）', e && e.message)
    return { errcode: 0, errmsg: 'success', build: BUILD, cost: Date.now() - t0 }
  }
}
