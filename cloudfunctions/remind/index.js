/**
 * 云函数 remind：疫苗/驱虫到期前一天推送订阅消息（PRD 7.2）
 * 定时触发器每日 09:00（北京时间）执行
 *
 * 旧工程踩坑经验（必须沿用）：
 * 1. 云函数容器默认 UTC，取「今天/明天」必须用 nowInChina()（本地 +8h）
 * 2. 个人版 cloud.openapi.subscribeMessage.send 会报 -501001，
 *    必须改用 axios 自换 access_token + HTTPS 调 cgi-bin/message/subscribe/send
 *    AppSecret 放环境变量 MINI_APPSECRET
 *
 * 环境变量：
 *  - MINI_APPSECRET：小程序 AppSecret
 *  - SUBSCRIBE_TEMPLATE_ID：订阅消息模板 ID（也可写死在下方常量）
 */
const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/**
 * 订阅消息模板：公共模板库「待办事项提醒」（模板编号 2983）
 * 关键词（序号由模板决定，换模板时只改下方 sendSubscribe 里的三个键名）：
 *   thing15 事项类型 → 我们放「到期事项」，如「猫三联、狂犬」
 *   time35  到期日期 → 需中文日期格式「2026年10月24日」
 *   thing12 备注消息 → 「明天到期，记得安排」
 * ⚠️ 换模板只改 TEMPLATE_ID + 这三个键名，值类型别动（thing ≤20 字，time 用中文日期）
 */
const TEMPLATE_ID = '5ObriH6TGCH2XO2T09gAz01-7OQvEjv3ZV2zVOMM1Es' // 与前端 utils/config.js 保持一致

/**
 * 消息跳转的版本：'formal' 正式版 / 'trial' 体验版 / 'developer' 开发版
 * ⚠️⚠️ 默认已是 formal（正式版）。联调体验版时，给云函数配环境变量 MINI_STATE=trial 临时覆盖即可，
 *    联调完记得**删掉该环境变量**（环境变量优先级高于这里的默认值，留着会让正式版用户收不到提醒）
 * ⚠️ 同理：若云端残留 MINI_STATE=trial，改代码默认值是无效的，必须去控制台改/删
 */
const MINIPROGRAM_STATE = process.env.MINI_STATE || 'formal'

/** 云函数容器是 UTC，北京时间 = UTC + 8h */
function nowInChina() {
  return new Date(Date.now() + 8 * 3600 * 1000)
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** '2026-10-24' → '2026年10月24日'（订阅消息 time/date 型用中文格式最稳，'2026-10-24' 有 47003 风险） */
function fmtDateCN(dateStr) {
  const p = String(dateStr || '').split('-')
  if (p.length !== 3) return dateStr
  return `${p[0]}年${Number(p[1])}月${Number(p[2])}日`
}

/** 用 appid + secret 换 access_token（云侧缓存于集合 tokenCache，避免频繁调用） */
async function getAccessToken() {
  // 简化缓存：直接每次获取（每日一次的量级可接受）；如需缓存可加集合
  const ctx = cloud.getWXContext() || {}
  // ⚠️ 定时触发器 / 云端手动测试这类「非用户调用」场景下 getWXContext().APPID 可能是空的，
  //    把空 appid 拼进 URL 换 token → 微信直接回 40013 invalid appid。
  //    所以允许用环境变量 MINI_APPID 兜底（云开发控制台配置，trim 掉复制时带的空格）
  const appid = String(process.env.MINI_APPID || ctx.APPID || '').trim()
  const secret = String(process.env.MINI_APPSECRET || '').trim()
  if (!secret) throw new Error('缺少环境变量 MINI_APPSECRET')
  if (!appid) throw new Error('取不到 appid：请给 remind 云函数配环境变量 MINI_APPID=小程序 AppID')

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
  const r = await axios.get(url, { timeout: 8000 })
  if (!r.data || !r.data.access_token) {
    // 把 appid 尾号和长度打出来：一眼分辨是「空的」还是「配的不是这个小程序」
    console.error('[remind] 换 token 失败 appid 尾号=', String(appid).slice(-4),
      '长度=', String(appid).length, '返回=', JSON.stringify(r.data))
    throw new Error('获取 access_token 失败: ' + JSON.stringify(r.data))
  }
  return r.data.access_token
}

/**
 * 兜底键名：解析模板内容失败时才用（当前模板「待办事项提醒」编号 2983）
 * 正常情况下 resolveTemplateKeys() 会从微信返回的模板内容里自动读出真实键名
 */
const FALLBACK_KEYS = { first: 'thing15', date: 'time35', second: 'thing12' }

let _tmplKeys = null

/**
 * 从微信「个人模板列表」里读出当前模板的关键词键名，实现「换模板不改代码」
 * 模板内容形如：`事项类型:{{thing15.DATA}}\n到期日期:{{time35.DATA}}\n备注消息:{{thing12.DATA}}`
 * 规则：第 1 个 thing = 事项、第 1 个 time/date = 日期、第 2 个 thing = 备注
 * @returns {Promise<{first:string,date:string,second:string}|null>}
 */
async function resolveTemplateKeys(accessToken) {
  if (_tmplKeys) return _tmplKeys
  try {
    const r = await axios.get(
      `https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate?access_token=${accessToken}`,
      { timeout: 8000 }
    )
    const list = (r.data && r.data.data) || []
    const tpl = list.find((t) => t.priTmplId === TEMPLATE_ID)
    if (!tpl || !tpl.content) {
      console.warn('[remind] 模板列表里没找到当前模板，使用兜底键名')
      return null
    }
    const keys = []
    // ⚠️ 键名一定带数字（thing15 / time35 / thing12）：字符类必须含 0-9。
    //    写成 [A-Za-z_]+ 会在遇到数字时匹配失败，keys 恒为空 → 静默回落兜底键名，
    //    而兜底值一旦和真实模板不一致，推送就是 47003（模板字段不匹配）
    const re = /\{\{([A-Za-z_][A-Za-z0-9_]*)\.DATA\}\}/g
    let m
    while ((m = re.exec(String(tpl.content))) !== null) keys.push(m[1])
    if (!keys.length) {
      // keys 为空基本就是正则写错了：不单独报警的话，现象只是「静默用兜底」，很难发现
      console.error('[remind] 模板内容里没解析出任何关键词占位符，使用兜底键名 content=', tpl.content)
      return null
    }
    const things = keys.filter((k) => k.indexOf('thing') === 0)
    const dateKey = keys.filter((k) => k.indexOf('time') === 0 || k.indexOf('date') === 0)[0]
    if (things.length < 2 || !dateKey) {
      console.warn('[remind] 模板关键词结构不符合预期，使用兜底键名 keys=', JSON.stringify(keys))
      return null
    }
    const parsed = { first: things[0], date: dateKey, second: things[1] }
    // 兜底值只是「识别失灵时的最后一道防线」：一旦和真实模板不符，推送会 47003。
    // 换模板后如果忘了同步 FALLBACK_KEYS，这里会提前喊出来
    if (FALLBACK_KEYS.first !== parsed.first || FALLBACK_KEYS.date !== parsed.date || FALLBACK_KEYS.second !== parsed.second) {
      console.error('[remind] 兜底键名与模板真实键名不一致（识别失效时会 47003）fallback=', JSON.stringify(FALLBACK_KEYS), 'real=', JSON.stringify(parsed))
    }
    _tmplKeys = parsed
    console.log('[remind] 自动识别模板键名 =', JSON.stringify(_tmplKeys))
    return _tmplKeys
  } catch (e) {
    console.warn('[remind] 解析模板键名失败，使用兜底键名', e && e.message)
    return null
  }
}

/** 发订阅消息（个人主体绕开 openapi 的 -501001） */
async function sendSubscribe(accessToken, payload) {
  const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`
  const r = await axios.post(url, payload, { timeout: 8000 })
  return r.data || {}
}

/**
 * ⚠️ 必须按「当前模板」过滤：换过模板后库里会同时存在新旧两条 ticket，
 *    裸 limit(1) 取到哪条全看数据库顺序 → 大概率取到旧模板那条（余额 0），
 *    表现为「前端明明显示有余额，推送时却判无额度」。
 *    口径与前端 utils/db.js 的 getSubBalance 保持一致（两边必须同时改）。
 */
async function loadBalance(openid) {
  const hit = await db.collection('subTickets')
    .where({ _openid: openid, tmplId: TEMPLATE_ID })
    .limit(1)
    .get()
    .catch(() => null)
  if (hit && hit.data && hit.data.length) return hit.data[0]
  // 老数据没有 tmplId 字段：退回裸查（与前端一致）
  const r = await db.collection('subTickets').where({ _openid: openid }).limit(1).get()
  return r.data[0] || null
}

async function decBalance(docId, balance) {
  await db.collection('subTickets').doc(docId).update({
    data: { balance: Math.max(0, balance - 1), updatedAt: db.serverDate() }
  })
}

async function logPushEvent(openid, result) {
  try {
    await db.collection('events').add({
      data: {
        eventId: `remind_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        event: 'remind_pushed',
        props: { result },
        critical: true,
        openid,
        serverTs: db.serverDate(),
        clientTs: Date.now()
      }
    })
  } catch (e) { /* 埋点失败不影响主流程 */ }
}

const TYPE_LABEL = { vaccine: '疫苗', dewormIn: '驱虫', dewormOut: '驱虫', checkup: '体检' }

// 版本信标：部署后在日志里找这一行，就能确认云端跑的是哪一版
// （云函数重新部署后控制台偶发仍调度旧实例，光看「部署成功」提示不可靠）
const BUILD = '20261023-c1'

exports.main = async (event) => {
  event = event || {}
  console.log('[remind] build =', BUILD, 'event =', JSON.stringify(event))
  // dryRun：只算不推（不标记 reminded、不扣余额），用于云端测试先看清「会推给谁、余额够不够」
  const dryRun = event.dryRun === true

  if (TEMPLATE_ID.indexOf('请填入') === 0) {
    console.log('尚未配置订阅消息模板 ID，本次跳过提醒')
    return { skipped: 'no-template' }
  }

  // 北京时间「明天」（扫描 nextDate == 明天）
  // debugDate：云端测试可传 '2026-10-24' 指定「今天」，便于不掐点造数据
  const nowCN = event.debugDate ? new Date(`${event.debugDate}T12:00:00+08:00`) : nowInChina()
  const tomorrowStr = fmtDate(new Date(nowCN.getTime() + 86400000))

  // dump：不按条件筛，直接吐最近 20 条 health 的关键字段
  // 用于回答「为什么 checked=0」：一眼看清 nextDate / remind / reminded 到底存成了什么
  if (event.dump) {
    const all = await db.collection('health').limit(20).get().catch((e) => {
      console.error('[remind] dump 失败', e && e.message)
      return { data: [] }
    })
    return {
      dump: true,
      tomorrow: tomorrowStr,
      count: (all.data || []).length,
      rows: (all.data || []).map((h) => ({
        id: h._id,
        petId: h.petId || '',
        type: h.type || '',
        nextDate: h.nextDate || '(空)',
        remind: h.remind,
        reminded: h.reminded
      }))
    }
  }

  /**
   * dumpSub：一次看清「谁有额度 / 谁在成员表里 / 宠物归谁」
   * 用法 {"dumpSub": true, "petId": "<宠物 id>"}
   * 用来回答「为什么每个人 balance 都是 0」：有记录吗？是本人的吗？openid 对得上吗？
   */
  if (event.dumpSub) {
    const petId = event.petId || ''
    const [subs, mem, petDoc] = await Promise.all([
      db.collection('subTickets').limit(50).get().catch(() => ({ data: [] })),
      petId ? db.collection('petMembers').where({ petId }).limit(20).get().catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
      petId ? db.collection('pets').doc(petId).get().catch(() => null) : Promise.resolve(null)
    ])
    const tail = (v) => String(v || '').slice(-6)
    return {
      dumpSub: true,
      subTickets: (subs.data || []).map((d) => ({
        uid: tail(d._openid), balance: d.balance, tmplId: d.tmplId
      })),
      members: (mem.data || []).map((m) => ({
        uid: tail(m._openid), role: m.role, status: m.status, notify: m.notify
      })),
      pet: petDoc && petDoc.data
        ? { id: petId, ownerOpenid: tail(petDoc.data.ownerOpenid || petDoc.data._openid), hasOwnerField: !!petDoc.data.ownerOpenid }
        : null
    }
  }

  /**
   * listTmpl：向微信要「当前 appid 下的个人模板列表」
   * 用来回答 40037 invalid template_id：代码里这个 ID 到底存不存在、真正的 ID 是什么、
   * 关键词键名长什么样（content 里是完整模板内容，形如「食物名称{{thing6.DATA}}」）
   */
  if (event.listTmpl) {
    let token = null
    try {
      token = await getAccessToken()
    } catch (e) {
      return { err: 'token 获取失败：' + e.message + '（先确认 MINI_APPID / MINI_APPSECRET）' }
    }
    const r = await axios
      .get(`https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate?access_token=${token}`, { timeout: 8000 })
      .catch(() => ({ data: {} }))
    const list = (r.data && r.data.data) || []
    return {
      currentTemplateId: TEMPLATE_ID,
      matched: list.some((t) => t.priTmplId === TEMPLATE_ID),
      errcode: r.data && r.data.errcode,
      templates: list.map((t) => ({
        id: t.priTmplId,
        title: t.title,
        type: t.type, // 2 一次性 / 3 长期
        content: t.content,
        keywordCount: (t.keywordEnumValueList || []).length
      }))
    }
  }

  /**
   * findTmpl：列出「当前类目下公共模板库里」标题含关键字的模板，用于换一个文案更贴切的
   * 用法 {"findTmpl": "提醒"}（不传默认「提醒」）
   * 返回 tid（模板标题 id）/ title / type（2 一次性、3 长期）/ 所属类目
   */
  if (event.findTmpl) {
    const kw = String(event.findTmpl).trim() || '提醒'
    let token = null
    try {
      token = await getAccessToken()
    } catch (e) {
      return { err: 'token 获取失败：' + e.message }
    }
    const catRes = await axios
      .get(`https://api.weixin.qq.com/wxaapi/newtmpl/getcategory?access_token=${token}`, { timeout: 8000 })
      .catch(() => ({ data: {} }))
    const cats = (catRes.data && catRes.data.data) || []
    const out = []
    for (const c of cats) {
      const r = await axios
        .get(`https://api.weixin.qq.com/wxaapi/newtmpl/getpubtemplatetitles?access_token=${token}&ids=${c.id}&start=0&limit=50`, { timeout: 8000 })
        .catch(() => ({ data: {} }))
      const list = (r.data && r.data.data) || []
      list.forEach((t) => {
        if (String(t.title || '').indexOf(kw) > -1) {
          out.push({ tid: t.tid, title: t.title, type: t.type, catId: c.id, catName: c.name })
        }
      })
    }
    // 顺带把前 5 个候选的关键词也查出来：光有标题不够，得看字段名/类型合不合适
    for (const t of out.slice(0, 5)) {
      const kres = await axios
        .get(`https://api.weixin.qq.com/wxaapi/newtmpl/getpubtemplatekeywords?access_token=${token}&tid=${t.tid}`, { timeout: 8000 })
        .catch(() => ({ data: {} }))
      t.keywords = ((kres.data && kres.data.data) || []).map((k) => ({
        name: k.name, type: k.keyword_type, example: k.example
      }))
    }

    return {
      keyword: kw,
      categories: cats.map((c) => ({ id: c.id, name: c.name })),
      count: out.length,
      templates: out
    }
  }

  /**
   * cleanOrphanSub：清掉没有 `_openid` 的历史「无主额度」
   * （subscribe 云函数漏写 _openid 时期攒下来的，永远推不出去也查不到，纯垃圾数据）
   */
  if (event.cleanOrphanSub) {
    const all = await db.collection('subTickets').limit(200).get().catch(() => ({ data: [] }))
    const orphans = (all.data || []).filter((d) => !d._openid)
    await Promise.all(orphans.map((d) =>
      db.collection('subTickets').doc(d._id).remove().catch(() => null)
    ))
    return {
      cleaned: orphans.length,
      remain: (all.data || []).length - orphans.length
    }
  }

  // 该推的记录：remind=true 且未推送过（云函数为管理端，跨用户全量扫描）
  const res = await db.collection('health')
    .where({ remind: true, reminded: _.neq(true), nextDate: tomorrowStr })
    .limit(1000)
    .get()

  // 二期收口：按「宠物」聚合到期记录，再对该宠物所有 notify=true 的 active 成员各推一份
  // PRD 5.6：两人都满足条件 → 各推一份、扣各自额度
  const byPet = {}
  res.data.forEach((h) => {
    if (!h.petId) return
    ;(byPet[h.petId] = byPet[h.petId] || []).push(h)
  })

  // 宠物名（备注文案要用）：按 petId 一次批量取，别在循环里逐条查
  const petNames = {}
  const petIds = Object.keys(byPet)
  if (petIds.length) {
    const pr = await db.collection('pets').where({ _id: _.in(petIds) }).limit(100).get().catch(() => ({ data: [] }))
    ;(pr.data || []).forEach((p) => { petNames[p._id] = p.name || p.nickname || '' })
  }

  // ⚠️ checked=0 时必须自带诊断：只返回一个 0，根本分不清是「没开提醒的记录」、
  //   「记录被标了 reminded」还是「nextDate 不是明天」。一次调用把这三类都摊开。
  let diag = null
  if (res.data.length === 0) {
    const all = await db.collection('health').where({ remind: true }).limit(100).get().catch(() => ({ data: [] }))
    const rows = all.data || []
    diag = {
      tomorrow: tomorrowStr,
      remindTotal: rows.length,
      remindedCount: rows.filter((h) => h.reminded === true).length,
      matchNextDate: rows.filter((h) => h.nextDate === tomorrowStr).length,
      noPetId: rows.filter((h) => !h.petId).length,
      nextDates: Array.from(new Set(rows.map((h) => String(h.nextDate)))).sort().slice(0, 12),
      samples: rows.slice(0, 6).map((h) => ({
        id: h._id, name: h.name || '', nextDate: h.nextDate,
        reminded: !!h.reminded, remindFailed: !!h.remindFailed, petId: h.petId || ''
      }))
    }
    console.log('[remind] checked=0 诊断 =', JSON.stringify(diag))
  }

  let accessToken = null
  let sent = 0
  let noBalance = 0
  let rejected = 0
  const preview = [] // dryRun 明细
  const noBalanceList = [] // 额度为 0 的 openid 后 6 位
  let kept = 0 // 因额度不足未推送、保留下来等下次的记录数

  // dryRun 时先把模板键名解析出来一起返回：换模板后一眼核对「自动识别的键名」和「微信真实键名」是否一致，
  // 不用再单独跑一次 listTmpl。解析失败不阻断 dryRun（可能只是 token / 环境变量没配好）
  let tmplKeys = null
  if (dryRun) {
    try {
      if (!accessToken) accessToken = await getAccessToken()
      tmplKeys = await resolveTemplateKeys(accessToken)
      console.log('[remind] 自动识别模板键名 =', JSON.stringify(tmplKeys))
    } catch (e) {
      tmplKeys = { err: String((e && e.message) || e) }
      console.error('[remind] 模板键名识别失败：', e && e.message)
    }
  }

  for (const petId of Object.keys(byPet)) {
    const records = byPet[petId]
    let petNoBalance = 0 // 本宠物内因额度不足被跳过的人数
    // 该宠物所有 notify=true 的 active 成员
    const mRes = await db.collection('petMembers')
      .where({ petId, status: 'active', notify: true })
      .get()
    let members = mRes.data || []

    if (!members.length) {
      // 兜底：存量宠物可能还没迁移出 petMembers 记录，回落到创建者（ownerOpenid → _openid）
      // 否则二期收口后老宠物的提醒会「静默不推」，只把记录标成已推送
      const petRes = await db.collection('pets').doc(petId).get().catch(() => null)
      const owner = petRes && petRes.data && (petRes.data.ownerOpenid || petRes.data._openid)
      if (owner) members = [{ _openid: owner, _fallback: true }]
    }

    if (!members.length) {
      // 无需推送的成员：直接标记 reminded，避免下次重复扫描
      if (!dryRun) {
        await Promise.all(records.map((h) =>
          db.collection('health').doc(h._id).update({ data: { reminded: true } })
        ))
      }
      continue
    }

    // 「事项类型」要的是类型（驱虫/疫苗/体检），不是具体药品名 —— 字段名就叫「事项类型」，
    // 塞「拜宠清」进去语义不符（用户第一眼会以为这是待办的名字）。
    const typeLabels = []
    records.forEach((h) => {
      const label = TYPE_LABEL[h.type] || '待办'
      if (typeLabels.indexOf(label) === -1) typeLabels.push(label)
    })
    const thingValue = `${typeLabels.slice(0, 3).join('、')}${typeLabels.length > 3 ? ' 等' : ''}`.slice(0, 20)

    // 备注：带宠物名更有温度（「明天到期，记得给小白安排上」）
    // ⚠️ 不放药品名：下次用的未必是同一种药，写进去反而是误导
    const petName = String(petNames[petId] || '').trim()
    let noteValue = petName ? `明天到期，记得给${petName}安排上` : '明天到期，记得安排'
    // thing 类型硬限 20 字：宠物名过长就退回通用文案，别截成半句
    if (noteValue.length > 20) noteValue = '明天到期，记得安排'

    let anySuccess = false

    for (const m of members) {
      const uid = m._openid
      if (!uid) continue

      // PRD 5.6：各查各的订阅余额
      // ⚠️ 额度必须属于「当前模板」：换模板后旧模板的额度不能拿来用
      //    （否则会拿着没订阅过的额度去推，微信侧必然 43101/40037，还白扣了记录）
      const ticket = await loadBalance(uid)
      // 缺 tmplId 的存量记录视为可用（与前端兜底口径一致）；有 tmplId 但不是当前模板 → 不可用
      const usable = !!ticket && (!ticket.tmplId || ticket.tmplId === TEMPLATE_ID)
      const balance = usable ? (ticket.balance || 0) : 0
      if (dryRun) {
        // 只回明细：openid 后 6 位 + 余额 + 将推送的文案，便于在控制台核对
        preview.push({
          petId,
          uid: String(uid).slice(-6),
          balance,
          thing: thingValue,
          date: fmtDateCN(tomorrowStr),
          note: noteValue,
          fallback: !!m._fallback
        })
        continue
      }
      if (balance <= 0) {
        // 一次性订阅：点一次授权才 +1。这里把「谁的额度是 0」露出来，否则只能看到计数干瞪眼
        noBalance++
        petNoBalance++
        noBalanceList.push(String(uid).slice(-6))
        console.log('[remind] 无订阅额度 uid=…' + String(uid).slice(-6), 'balance=', balance)
        await logPushEvent(uid, 'no_balance')
        continue
      }

      try {
        if (!accessToken) accessToken = await getAccessToken()
        // 键名从模板内容里自动识别（换模板不用改代码），失败才回落常量
        const keys = (await resolveTemplateKeys(accessToken)) || FALLBACK_KEYS
        // ⚠️ 字段名必须是下划线：微信 subscribeMessage.send 只认 template_id / miniprogram_state。
        //    写成驼峰（templateId/miniprogramState）微信收不到模板 ID，直接回 40037 invalid template_id
        const sendRes = await sendSubscribe(accessToken, {
          touser: uid,
          template_id: TEMPLATE_ID,
          // ⚠️ 订阅消息的 page 支持带 query（小程序内 navigateTo 到 tabBar 页才不行，这是两回事）。
          //    带上 from=remind 让首页 onLoad 能识别「用户是从到期提醒点进来的」，
          //    据此展示触点 5（顺带问问店长），并把 source 归因到 remind_landing
          // ⚠️ 这里在 `for (const m of members)` 里，外层没有 h —— 曾写成 h._id，
          //    运行时抛 ReferenceError 被下面的 catch 吞掉，导致「推送 100% 失败且静默」：
          //    记录照样标 reminded=true、余额不扣、用户永远收不到，日志只有一句"推送异常"。
          //    dryRun 分支在上面就 continue 了，所以 dryRun 永远测不出这个 Bug。
          page: `pages/home/home?from=remind&rid=${(records[0] && records[0]._id) || ''}`,
          miniprogram_state: MINIPROGRAM_STATE,
          lang: 'zh_CN',
          data: {
            [keys.first]: { value: thingValue },              // 事项（thing，≤20 字）
            [keys.date]: { value: fmtDateCN(tomorrowStr) },   // 日期（time/date，中文格式最稳）
            [keys.second]: { value: noteValue }               // 备注（thing）：具体项目/药品名
          }
        })
        if (sendRes.errcode === 0) {
          sent++
          anySuccess = true
          await decBalance(ticket._id, balance)
          await logPushEvent(uid, 'success')
        } else {
          // 43101 = 用户拒收；47003 = 模板字段不匹配（键名 / 值类型 / 长度）
          // 错误码必须打到日志，否则「没收到消息」完全无从定位
          rejected++
          console.error('[remind] 推送失败 uid=', uid, 'errcode=', sendRes.errcode, 'errmsg=', sendRes.errmsg)
          await logPushEvent(uid, 'rejected')
        }
      } catch (e) {
        console.error('推送异常 uid=', uid, e.message)
        rejected++
        await logPushEvent(uid, 'error')
      }
    }

    // ⚠️ 只有在「所有人都因额度不足没推出去」时，才保留记录不标 reminded
    //    —— 否则用户补了额度，记录却已被判「已推送」，永远等不到第二次推送（首次联调踩过）
    // ⚠️ 但只要有一个人推送成功就照常标记：不能让额度不足的旁人拖住本该收到消息的人
    if (!anySuccess && petNoBalance > 0) {
      kept += records.length
      console.log('[remind] 全员额度不足，本批记录保留待推 petId=', petId, 'records=', records.length)
      continue
    }

    // 全员处理完后统一标记记录：reminded=true（避免重复扫描）；remindFailed 仅在全员都失败时为 true
    // dryRun 不落标记，否则测试一次就把记录「推过」了，后面真跑再也命中不到
    if (!dryRun) {
      await Promise.all(records.map((h) =>
        db.collection('health').doc(h._id).update({ data: { reminded: true, remindFailed: !anySuccess } })
      ))
    }
  }

  return {
    build: BUILD, // 返回值里也带上：一眼判断云端版本
    dryRun,
    tomorrow: tomorrowStr,
    state: MINIPROGRAM_STATE,
    tmplKeys, // dryRun 才有：自动识别到的模板键名（{first,date,second}）
    diag, // checked=0 才有：为什么一条都没选中
    checked: res.data.length,
    pets: Object.keys(byPet).length,
    sent,
    noBalance,
    noBalanceList,
    kept,
    rejected,
    preview
  }
}
