/**
 * 运营后台（PRD R8）：换投放素材、改欢迎语/非工作时间话术、看各触点点击数
 *
 * ⚠️ 提审合规：本页文案一律用中性词 —— 对外承接物统称「素材」，渠道只用 A/B/C 字母。
 *    页面虽需管理员鉴权才能看到内容，但它**在提审包里**，自动化扫描有概率命中敏感词；
 *    一旦被认定诱导站外导流，处罚是封禁分享能力甚至下架。改文案时不要改回去。
 *    （云侧 csConfig/group_code 的字段名保持原样 —— 云端配置审核方看不到。）
 *
 * 入口：我的页长按版本号 → 埋点自检面板 → 底部「客服运营后台」按钮（隐藏，不对用户暴露）
 *
 * ⚠️ 为什么不做成云开发静态托管的网页：
 *    网页要调云函数得先开「匿名登录」或「HTTP 访问服务」，等于多配一套对外鉴权；
 *    而运营者本来就在手机上用小程序，素材图片用 chooseMedia 选图直传更顺。
 *    复用小程序已有的静默登录态，零额外鉴权成本。
 *
 * ⚠️ 口令只存在本次页面生命周期的 data 里，不落 storage（避免长期留在用户手机上）
 */
const U = require('../../utils/util')
const CS = require('../../utils/cs')
const config = require('../../utils/config')

const GROUPS = ['A', 'B', 'C']

/** 物种 key → 中文（复用 config.SPECIES，别在这里另立一份） */
function speciesName(key) {
  const k = String(key || '')
  if (!k) return ''
  const hit = (config.SPECIES || []).filter((s) => s.key === k)[0]
  return hit ? hit.name : k
}

/**
 * 会话列表第三行的副标题
 * 昵称 / 宠物信息 / openid 尾号三样都要露出来：
 *   昵称回答「是谁」，宠物回答「TA 的谁」，尾号用来和后台记录对账
 */
function idLine(s) {
  const bits = []
  if (s.petName) {
    const sp = speciesName(s.species)
    bits.push(s.petName + (sp ? '（' + sp + '）' : ''))
  }
  bits.push('openid ' + (s.who || ''))
  if (!s.nickname) bits.push('未设昵称')
  return bits.join(' · ')
}

/** 触点中文名（与 utils/cs.js 的 SOURCES 对应） */
const SRC_LABEL = {
  mine_ask: '我的页',
  milestone_birthday: '生日/周年',
  share_done: '长图成功页',
  health_unknown: '健康页空态',
  remind_landing: '提醒落地页'
}

/** 个位补零（时间格式化用） */
function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

/** 所有异步都要超时兜底（项目铁律）：否则接口挂起会让页面看起来"点了没反应" */
function withTimeout(p, ms, tag) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时：' + tag)), ms))
  ])
}

Page({
  data: {
    authed: false,
    token: '',
    loading: false,
    err: '',
    seg: 'chat', // 一级：chat | data | mod | set（欢迎语/时段/素材收进「设置」，触点收进「数据·触点」）
    // 数据页签的二级：board 大盘 | users 用户 | touch 触点（沿用 mod 页签 mseg 的二级模式）
    dseg: 'board',
    // 内容审核的二级页签
    mseg: 'reports',
    // 数据看板：今日实时 + 按天历史（dailyStats action）
    today: null,
    statRows: [],
    statErr: '',
    statsLoading: false,
    // 用户明细（userList action）+ 单用户打开记录（userVisits action）
    usersList: [],
    usersErr: '',
    usersLoading: false,
    visitsOpenid: '',
    visits: [],
    modReports: [],
    modAppeals: [],
    secTesting: false,
    secTestLines: [],
    stats: [],
    welcome: '',
    hours: { start: 9, end: 22, text: '' },
    groupCode: {},
    groupMap: {},
    build: '',
    saving: false,
    uploading: '',
    // 账号白名单：null = 还没探测完
    isAdmin: null,
    // 探测是否已结束：否则 isAdmin 还是 null 时口令卡片会先闪一下
    probeDone: false,
    adminLocked: false,
    myOpenid: '',
    probeErr: '',
    // 会话（自建客服接待）
    sessions: [],
    messages: [],
    curOpenid: '',
    inputText: '',
    chatLoading: false,
    sending: false,
    // 链路自检（排「消息收不到」）
    checking: false,
    checks: [],
    checkVerdict: '',
    checkMissing: [],
    // 当前会话对方资料（客服推送只给 openid，昵称头像要从 users 表查）
    peer: {},
    // 消息列表滚动锚点：轮询到新消息后自动滚到底
    scrollTo: ''
  },

  onLoad() {
    this.checkAdmin()
  },

  onShow() {
    if (this.data.authed) this.startPoll()
  },

  onHide() {
    this.stopPoll()
  },

  onUnload() {
    this.stopPoll()
    // 离开页面即清口令：运营口令不落 storage、不长期留在内存里
    this.setData({ token: '', authed: false })
  },

  /* ---------- 轮询：运营页面停留时要能自己刷出新消息 ---------- */

  /**
   * 会话页开着的时候，用户再发消息，运营必须能看见。
   * 云开发数据库 watch 实时监听在这里不适用：csSessions 权限是「所有用户不可读写」，
   * 前端连读都不行，只能走云函数 —— 所以用低成本轮询（5s）代替长连接。
   *
   * ⚠️ 必须在 onHide / onUnload 清掉，否则页面切走后定时器还在打云函数（白烧调用次数）
   */
  startPoll() {
    this.stopPoll()
    this._timer = setInterval(() => this.pollTick(), 5000)
  },
  stopPoll() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  },
  async pollTick() {
    if (!this.data.authed || this.data.seg !== 'chat') return
    // 上一次还没回来就跳过这一拍，避免网络慢时请求堆积
    if (this._polling) return
    this._polling = true
    try {
      if (this.data.curOpenid) {
        await this.openChatBy(this.data.curOpenid, true)
        await this.call('markRead', { token: this.data.token, openid: this.data.curOpenid })
      } else {
        await this.loadSessions(true)
      }
    } finally {
      this._polling = false
    }
  },

  /**
   * 账号白名单探测
   * 双请求：whoami（无鉴权，只回 locked + myOpenid）+ probe（过闸，服务端只回一个布尔）
   * ⚠️ 一律**先问云端**，缓存只做离线兜底：
   *    早期版本先把缓存当短路条件 → 从「我的」页点进来时缓存已在 → 直接 return，
   *    `locked` 没落进 data → 明明白名单已锁，页面还是让输口令（已踩）
   * @returns {Promise<boolean>} 是否放行
   */
  async checkAdmin() {
    const app = getApp()
    const cached = app && app.globalData && app.globalData.csAdminInfo
    try {
      const [w, p] = await Promise.all([
        withTimeout(
          wx.cloud.callFunction({ name: 'csAdmin', data: { action: 'whoami' } }),
          10000, 'whoami'
        ),
        withTimeout(
          wx.cloud.callFunction({ name: 'csAdmin', data: { action: 'probe' } }),
          10000, 'probe'
        )
      ])
      const who = (w && w.result) || {}
      const pr = (p && p.result) || {}
      const res = {
        isAdmin: !!pr.ok,
        locked: !!who.locked,
        myOpenid: who.myOpenid || '',
        build: who.build || ''
      }
      if (app && app.globalData) {
        // 只缓存「通过」的整份结果；负结果缓存了会掩盖后来补配的白名单
        if (res.isAdmin) app.globalData.csAdminInfo = res
        app.globalData.csAdmin = res.isAdmin
      }
      this.applyWhoami(res)
      return res.isAdmin
    } catch (e) {
      // 网络不通时才用缓存兜底（缓存里必然是通过过的那份）
      if (cached) {
        console.warn('[ops] 权限探测失败，用缓存兜底', e && e.message)
        this.applyWhoami(cached)
        return !!cached.isAdmin
      }
      // 没有缓存 + 探测失败 → 按「无权限」处理（fail-close），不因为报错就放行
      console.error('[ops] 权限探测失败', e && e.message)
      this.setData({ isAdmin: false, probeDone: true, probeErr: (e && e.message) || '未知' })
      return false
    }
  },

  /** 把探测结果落到 data，并决定要不要免口令直进 */
  applyWhoami(res) {
    const ok = !!res.isAdmin
    this.setData({
      isAdmin: ok,
      probeDone: true,
      adminLocked: !!res.locked,
      myOpenid: res.myOpenid || '',
      build: this.data.build || res.build || ''
    })
    // 已锁定且是管理员 → 不用输口令，直接进入（openid 本身就是身份凭证）
    // 已经进过就别重复打一次 overview
    if (ok && res.locked && !this.data.authed) this.onLogin()
  },

  /**
   * 复制 openid
   * ⚠️ 必须带 success / fail 回调：`wx.setClipboardData` 失败时是**静默**的，
   *    无回调 = 用户点完「没任何反应」，也不知道是没复制上还是复制了但粘贴不出来（已踩）
   * ⚠️ 兜底：失败弹窗把 openid 显示出来，配合 wxml 上 text 的 user-select，
   *    用户长按就能选中复制 —— 不能只给一条路
   */
  onCopyOpenid() {
    const v = String(this.data.myOpenid || '')
    if (!v) {
      U.toast('还没拿到 openid，重新进一次这页')
      return
    }
    // 统一走 utils/util 的 copyText：成功有提示、失败会把原因说出来（隐私接口未声明时尤其重要）
    U.copyText(v)
  },

  onTokenInput(e) {
    this.setData({ token: (e && e.detail && e.detail.value) || '' })
  },

  /** 统一调用入口：带超时 + 统一错误提示 */
  async call(action, extra) {
    try {
      const r = await withTimeout(
        wx.cloud.callFunction({
          name: 'csAdmin',
          data: Object.assign({ action }, extra || {})
        }),
        15000, action
      )
      return (r && r.result) || null
    } catch (e) {
      console.error('[ops] 调用失败', action, e && e.message)
      return { ok: false, err: (e && e.message) || '网络不太好' }
    }
  },

  async onLogin() {
    const token = String(this.data.token || '').trim()
    // 白名单锁定后口令变可选（此时 openid 已是身份凭证），未锁定时必填
    if (!this.data.adminLocked && !token) { U.toast('请输入运营口令'); return }
    this.setData({ loading: true, err: '' })
    const r = await this.call('overview', { token })
    this.setData({ loading: false })
    if (!r || !r.ok) {
      this.setData({ err: (r && r.err) || '登录失败' })
      return
    }
    this.setData({
      authed: true,
      stats: r.stats || [],
      welcome: r.welcome || '',
      hours: r.hours || { start: 9, end: 22, text: '' },
      groupCode: r.groupCode || {},
      groupMap: r.groupMap || {},
      build: r.build || ''
    })
    // 顺手把会话列表拉出来，切到「会话」页签时不用再等
    this.loadSessions()
    // 进去就开始轮询，用户再发消息能自己刷出来
    this.startPoll()
  },

  onLogout() {
    this.stopPoll()
    this.setData({ authed: false, err: '', build: '' })
  },

  onSeg(e) {
    const seg = (e && e.currentTarget && e.currentTarget.dataset.seg) || 'chat'
    this.setData({ seg })
    if (seg === 'chat') this.loadSessions()
    if (seg === 'mod') this.loadMod()
    if (seg === 'data') this.loadStats()
  },

  /* ---- 数据看板（大盘 / 用户 / 触点）----
     ⚠️ 权限校验在 csAdmin 服务端，前端只负责展示与发起 */

  onDseg(e) {
    const dseg = (e && e.currentTarget && e.currentTarget.dataset.d) || 'board'
    this.setData({ dseg })
    if (dseg === 'users') this.loadUsers()
  },

  /**
   * 拉看板：今天实时 + 历史 13 天，一次请求
   * 页面级缓存 60s：来回切页签不重复打云函数；想看最新点「刷新」（强制）
   */
  async loadStats(force) {
    if (this.data.statsLoading) return
    if (!force && this.data.statRows.length && Date.now() - (this._statsAt || 0) < 60000) return
    this.setData({ statsLoading: true })
    const r = await this.call('dailyStats', { days: 14 })
    this._statsAt = Date.now()
    if (!r || !r.ok) {
      this.setData({ statsLoading: false, statErr: (r && r.err) || '拉取失败（csAdmin 需更新部署）' })
      return
    }
    const t = r.today || {}
    // 横条按 DAU 归一化：最大的那天拉满，其余按比例
    const dauMax = Math.max.apply(null, [t.dau || 0].concat((r.days || []).map((x) => x.dau || 0)).concat([1]))
    const mkRow = (x) => ({
      key: (x.live ? 'live-' : '') + x.date,
      dateText: x.live ? '今天' : String(x.date || '').slice(5),
      dau: x.dau || 0,
      newUsers: x.newUsers || 0,
      sessions: x.sessions || 0,
      launches: x.launches || 0,
      pets: x.petsCreated || 0,
      records: x.recordsAdded || 0,
      posts: x.postsAdded || 0,
      dauBar: Math.round(((x.dau || 0) / dauMax) * 100),
      live: !!x.live,
      asOf: x.asOf || ''
    })
    this.setData({
      statsLoading: false,
      statErr: '',
      today: t,
      statRows: [mkRow(t)].concat((r.days || []).map(mkRow))
    })
  },

  onRefreshStats() {
    this.loadStats(true)
  },

  /** 用户明细：60s 缓存同上 */
  async loadUsers(force) {
    if (this.data.usersLoading) return
    if (!force && this.data.usersList.length && Date.now() - (this._usersAt || 0) < 60000) return
    this.setData({ usersLoading: true })
    const r = await this.call('userList', { limit: 100 })
    this._usersAt = Date.now()
    if (!r || !r.ok) {
      this.setData({ usersLoading: false, usersErr: (r && r.err) || '拉取失败（csAdmin 需更新部署）' })
      return
    }
    const now = new Date()
    const yest = new Date(now.getTime() - 86400000)
    const list = (r.list || []).map((x) => {
      const tail = String(x.openid || '').slice(-6)
      const d = x.lastTs ? new Date(x.lastTs) : null
      let lastText = '—'
      if (d && !isNaN(d.getTime())) {
        const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
        if (d.toDateString() === now.toDateString()) lastText = hm
        else if (d.toDateString() === yest.toDateString()) lastText = '昨天 ' + hm
        else lastText = (d.getMonth() + 1) + '月' + d.getDate() + '日'
      }
      return Object.assign({}, x, {
        tail,
        lastText,
        initial: (x.nickname || '尾' + tail).slice(0, 2)
      })
    })
    this.setData({ usersLoading: false, usersErr: '', usersList: list })
  },

  onRefreshUsers() {
    this.loadUsers(true)
  },

  /**
   * 点某一行 → 展开/收起他的逐次打开记录（app_launch 按 sId 合并）
   * 展开结果按 openid 缓存 60s，收起再展开不重复请求
   */
  async onUserTap(e) {
    const oid = (e && e.currentTarget && e.currentTarget.dataset.oid) || ''
    if (!oid) return
    if (this.data.visitsOpenid === oid) {
      this.setData({ visitsOpenid: '', visits: [] })
      return
    }
    this.setData({ visitsOpenid: oid, visits: [] })
    this._visitsCache = this._visitsCache || {}
    let v = this._visitsCache[oid]
    if (!v || Date.now() - v.at > 60000) {
      const r = await this.call('userVisits', { openid: oid })
      v = { at: Date.now(), list: (r && r.list) || [] }
      this._visitsCache[oid] = v
    }
    // 请求回来时用户可能已点开别的行
    if (this.data.visitsOpenid !== oid) return
    const SCENE = { 1001: '发现栏', 1007: '聊天卡片', 1008: '群聊卡片', 1089: '最近使用', 1011: '扫码', 1047: '小程序码' }
    const visits = v.list.map((x, idx) => {
      const d = x.ts ? new Date(x.ts) : null
      return {
        i: idx,
        t: d && !isNaN(d.getTime())
          ? (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
          : '—',
        scene: SCENE[x.scene] || ('场景' + (x.scene || '?')),
        launches: x.launches || 1
      }
    })
    this.setData({ visits })
  },

  /* ---- 内容审核（PRD《内容安全与风控》第 10 节） ----
     ⚠️ 权限校验在 csAdmin 服务端（openid 白名单 + 口令），前端这里只负责展示与发起 */

  onMSeg(e) {
    const m = (e && e.currentTarget && e.currentTarget.dataset.m) || 'reports'
    this.setData({ mseg: m })
  },

  async loadMod() {
    const [rr, ra] = await Promise.all([
      this.call('listReports', { token: this.data.token }),
      this.call('listAppeals', { token: this.data.token })
    ])
    if (rr && rr.ok === false) { U.toast((rr && rr.err) || '拉取举报失败'); return }
    const RMAP = {
      porn: '色情低俗', violence: '暴力血腥', illegal: '违法违规',
      abuse: '辱骂引战', other: '其他'
    }
    const reports = ((rr && rr.list) || []).map((x) => Object.assign({}, x, {
      reasonText: ((x.reasons || []).map((k) => RMAP[k] || k)).join(' / ')
    }))
    this.setData({ modReports: reports, modAppeals: (ra && ra.list) || [] })
  },

  onReloadMod() {
    this.loadMod()
  },

  async onHandleReport(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset.id) || ''
    const act = (e && e.currentTarget && e.currentTarget.dataset.act) || 'delete'
    if (!id) return
    // 封禁是重动作（会连带下架他全部历史内容），必须二次确认
    if (act === 'ban') {
      const yes = await new Promise((resolve) => {
        wx.showModal({
          title: '确认封禁这个用户',
          content: '会删除这条内容并封禁他，他名下全部历史内容也会一并下架。解封需要再来这里操作。',
          confirmText: '确认封禁',
          cancelText: '再想想',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false)
        })
      })
      if (!yes) return
    }
    const r = await this.call('handleReport', { token: this.data.token, postId: id, act })
    if (!r || !r.ok) { U.toast('处理失败：' + ((r && r.err) || '未知')); return }
    U.toast(act === 'ban'
      ? ('已删除并封禁，连带下架 ' + (r.tookDown || 0) + ' 条历史内容')
      : (act === 'delete' ? '已删除' : '已驳回，内容已恢复'))
    this.loadMod()
  },

  /**
   * 内容安全接口自检（调 petData 的 secSelfTest，不走 csAdmin）
   *
   * 为什么要这个按钮：检测接口挂掉时，现象和「内容都很干净」**完全一样**（都发得出去），
   * 没有它就只能翻日志猜。一键跑完能立刻区分「接口通」和「接口挂了在静默放行」。
   */
  async onSecSelfTest() {
    this.setData({ secTesting: true, secTestLines: [] })
    try {
      const r = await wx.cloud.callFunction({ name: 'petData', data: { action: 'secSelfTest' } })
      const res = (r && r.result) || {}
      const VMAP = { ok: '通过', reject: '命中风险', error: '调用失败' }
      const lines = []
      if (res.text) {
        lines.push('文案检测：' + (res.text.pass ? '通过' : '命中风险')
          + (res.text.unchecked ? '（⚠️ 服务不可用，现在是放行）' : '')
          + ' · ' + res.text.ms + 'ms')
      }
      if (res.image) {
        lines.push(res.image.skipped
          ? ('图片检测：跳过（' + res.image.note + '）')
          : ('图片检测：' + (VMAP[res.image.verdict] || res.image.verdict)
            + ' · ' + Math.round((res.image.bytes || 0) / 1024) + 'KB'
            + ' · ' + res.image.ms + 'ms'
            + (res.image.note ? ' · ' + res.image.note : '')))
      }
      if (res.cols) {
        const bad = Object.keys(res.cols).filter((k) => res.cols[k] !== 'ok')
        lines.push(bad.length ? ('⚠️ 集合缺失：' + bad.join('、')) : '风控集合：全部就绪')
      }
      if (res.forceReject) lines.push('强制拦截开关：' + res.forceReject)
      if (res.build) lines.push('云端 build：' + res.build)
      this.setData({ secTestLines: lines })
    } catch (e) {
      console.error('[ops] 自检失败', e)
      this.setData({ secTestLines: ['调用失败：' + ((e && e.message) || '未知')] })
    } finally {
      this.setData({ secTesting: false })
    }
  },

  async onResolveAppeal(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset.id) || ''
    const pass = String((e && e.currentTarget && e.currentTarget.dataset.p) || '0') === '1'
    if (!id) return
    const r = await this.call('resolveAppeal', { token: this.data.token, postId: id, pass })
    if (!r || !r.ok) { U.toast('处理失败：' + ((r && r.err) || '未知')); return }
    U.toast(pass ? ('已恢复，白名单新增 ' + (r.whitelisted || 0) + ' 张图') : '已维持下架')
    this.loadMod()
  },

  onWelcomeInput(e) {
    this.setData({ welcome: (e && e.detail && e.detail.value) || '' })
  },

  onHoursTextInput(e) {
    this.setData({ 'hours.text': (e && e.detail && e.detail.value) || '' })
  },

  onHoursStart(e) {
    this.setData({ 'hours.start': Number((e && e.detail && e.detail.value) || 0) })
  },

  onHoursEnd(e) {
    this.setData({ 'hours.end': Number((e && e.detail && e.detail.value) || 0) })
  },

  async onSaveWelcome() {
    if (!this.data.welcome.trim()) { U.toast('欢迎语不能为空'); return }
    this.setData({ saving: true })
    const r = await this.call('setWelcome', { token: this.data.token, text: this.data.welcome })
    this.setData({ saving: false })
    U.toast(r && r.ok ? '已保存' : ('保存失败：' + ((r && r.err) || '')))
  },

  async onSaveHours() {
    const h = this.data.hours
    if (Number(h.start) >= Number(h.end)) { U.toast('结束时间要晚于开始时间'); return }
    this.setData({ saving: true })
    const r = await this.call('setHours', {
      token: this.data.token,
      start: Number(h.start),
      end: Number(h.end),
      text: h.text
    })
    this.setData({ saving: false })
    U.toast(r && r.ok ? '已保存' : ('保存失败：' + ((r && r.err) || '')))
  },

  /**
   * 换素材：选图 → 规整本地路径 → 读 base64 → 云函数上传云存储
   * ⚠️ DevTools / 部分真机上 chooseMedia 返回的是 http://tmp/xxx.png，
   *    这种链接 FileSystemManager 与 cloud.uploadFile 都用不了，必须先落盘换本地路径
   *    （本项目 avatar-cropper 已踩过）
   */
  async onPickCode(e) {
    const g = String((e && e.currentTarget && e.currentTarget.dataset.g) || '').toUpperCase()
    if (GROUPS.indexOf(g) === -1) return
    try {
      const media = await withTimeout(
        wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] }),
        20000, 'chooseMedia'
      )
      const raw = media && media.tempFiles && media.tempFiles[0] && media.tempFiles[0].tempFilePath
      if (!raw) return
      this.setData({ uploading: g })
      const local = await this.toLocal(raw)
      const fs = wx.getFileSystemManager()
      const b64 = await withTimeout(new Promise((res, rej) => {
        fs.readFile({ filePath: local, encoding: 'base64', success: (r) => res(r.data), fail: rej })
      }), 15000, 'readFile')
      const r = await this.call('setGroupCode', { token: this.data.token, group: g, base64: b64 })
      // 清理落盘的唯一命名临时文件，防 USER_DATA_PATH 累积
      if (local && local.indexOf(wx.env.USER_DATA_PATH) === 0) {
        try { fs.unlink({ filePath: local }) } catch (e) { /* 忽略 */ }
      }
      this.setData({ uploading: '' })
      if (r && r.ok) {
        U.toast(`素材 ${g} 已更新`)
        this.refresh()
      } else {
        U.toast('上传失败：' + ((r && r.err) || ''))
      }
    } catch (err) {
      this.setData({ uploading: '' })
      const msg = (err && err.message) || ''
      // 用户取消选图不是错误，静默返回
      if (msg.indexOf('cancel') === -1) U.toast(msg || '选图失败')
    }
  },

  /**
   * 把临时路径规整成本地可用路径
   * ① 先试 getImageInfo（返回 path 是本地路径）
   * ② 仍是 http://tmp 就 saveFile 落盘到 USER_DATA_PATH（唯一命名，避免同名缓存旧图）
   * ③ 都失败就原样返回，让上层链路去报错（不静默吞）
   */
  async toLocal(src) {
    try {
      const info = await withTimeout(wx.getImageInfo({ src }), 8000, 'getImageInfo')
      if (info && info.path && String(info.path).indexOf('http') !== 0) return info.path
    } catch (e) { /* 继续走落盘 */ }

    if (String(src).indexOf('http://tmp/') === 0) {
      const fs = wx.getFileSystemManager()
      const dst = `${wx.env.USER_DATA_PATH}/cs_code_${Date.now()}.png`
      await withTimeout(new Promise((res, rej) => {
        fs.saveFile({ tempFilePath: src, filePath: dst, success: res, fail: rej })
      }), 15000, 'saveFile')
      return dst
    }
    return src
  },

  async refresh() {
    const r = await this.call('overview', { token: this.data.token })
    if (!r || !r.ok) { this.setData({ err: (r && r.err) || '读取失败' }); return }
    this.setData({
      stats: (r.stats || []).map((x) => Object.assign({}, x, { label: SRC_LABEL[x.source] || x.source })),
      welcome: r.welcome || '',
      hours: r.hours || { start: 9, end: 22, text: '' },
      groupCode: r.groupCode || {},
      groupMap: r.groupMap || {},
      build: r.build || ''
    })
  },

  async onReload() {
    await this.refresh()
  },

  /* ---------- 会话（自建客服接待） ---------- */

  /**
   * 拉会话列表
   * @param {boolean} silent 轮询用：不显示 loading、不弹 toast、内容没变就不 setData
   *                         （每 5 秒无脑 setData 会让整页闪一下，很难看）
   */
  async loadSessions(silent) {
    if (!silent) this.setData({ chatLoading: true })
    const r = await this.call('listSessions', { token: this.data.token })
    if (!silent) this.setData({ chatLoading: false })
    if (!r || !r.ok) {
      if (!silent) U.toast((r && r.err) || '读取失败')
      return
    }
    const list = (r.sessions || []).map((s) => Object.assign({}, s, {
      timeText: s.lastAt ? U.fmtDate(new Date(s.lastAt)).slice(5) + ' ' + U.pad(new Date(s.lastAt).getHours()) + ':' + U.pad(new Date(s.lastAt).getMinutes()) : '',
      srcText: SRC_LABEL[s.source] || s.source || '',
      // 显示优先级：微信昵称 → 宠物名 → openid 尾号。
      // 昵称要用户自己在「我的」页填，「朵屁」这种宠物名反而更好认，所以排第二
      nameText: s.nickname || s.petName || ('微信用户 ' + (s.who || '')),
      initial: (s.nickname || s.petName || '宠').slice(0, 1),
      idText: idLine(s)
    }))
    // 指纹比对：openid + 最后消息时间 + 未读数，三者都没变就不重渲染
    const sig = list.map((x) => x.openid + '|' + x.lastAt + '|' + x.unread).join(',')
    if (silent && sig === this._sessSig) return
    this._sessSig = sig
    this.setData({ sessions: list })
  },

  async openChat(e) {
    const openid = String((e && e.currentTarget && e.currentTarget.dataset.oid) || '')
    if (!openid) return
    await this.openChatBy(openid, false)
  },

  /** 手动刷新按钮：⚠️ 不能直接 bindtap="loadSessions" —— tap 事件对象会被当成 silent 参数传进去 */
  onRefreshSessions() {
    this.loadSessions(false)
  },

  /**
   * 打开某个会话
   * @param {boolean} silent 轮询用：不清空已有消息、不显示 loading，只在有新消息时追加
   */
  async openChatBy(openid, silent) {
    if (!openid) return
    if (!silent) this.setData({ curOpenid: openid, chatLoading: true, messages: [], peer: {} })
    else if (this.data.curOpenid !== openid) return
    const r = await this.call('listMessages', { token: this.data.token, openid })
    if (!silent) this.setData({ chatLoading: false })
    if (!r || !r.ok) {
      if (!silent) U.toast((r && r.err) || '读取失败')
      return
    }
    const raw = r.messages || []
    // 指纹：条数 + 最后一条时间。没变就不动界面（否则滚动位置会被反复重置）
    const sig = openid + '|' + raw.length + '|' + (raw.length ? raw[raw.length - 1].ts : 0)
    if (silent && sig === this._msgSig) return
    this._msgSig = sig
    const msgs = raw.map((m, i) => Object.assign({}, m, {
      mid: 'm' + i,
      timeText: m.ts ? U.pad(new Date(m.ts).getHours()) + ':' + U.pad(new Date(m.ts).getMinutes()) : ''
    }))
    const p = r.peer || {}
    this.setData({
      messages: msgs,
      // ⚠️ 首字在这里算好：WXML 表达式不支持 .slice，写在模板里会编译报错
      peer: Object.assign({}, p, {
        nameText: p.nickname || p.petName || ('微信用户 ' + (p.who || '')),
        initial: (p.nickname || p.petName || '宠').slice(0, 1),
        idText: idLine(p)
      }),
      // 有新消息时滚到底；首次打开也滚到底（最新的在最下面）
      scrollTo: msgs.length ? msgs[msgs.length - 1].mid : ''
    })
    // 进会话即清未读，避免轮询期间角标一直涨
    if (!silent) this.call('markRead', { token: this.data.token, openid })
  },

  backToList() {
    this._msgSig = ''
    this.setData({ curOpenid: '', messages: [], inputText: '', peer: {}, scrollTo: '' })
    this.loadSessions()
  },

  /**
   * 链路自检
   * 「会话列表为空」有两种完全不同的原因：真的没人发、和消息压根没进来。
   * 界面上这两者长得一模一样，所以必须让云端把集合存在性 / 条数报出来。
   */
  async onSelfcheck() {
    this.setData({ checking: true, checkVerdict: '', checks: [], checkMissing: [] })
    const r = await this.call('selfcheck', { token: this.data.token })
    this.setData({ checking: false })
    if (!r || !r.ok) {
      this.setData({ checkVerdict: '自检失败：' + ((r && r.err) || 'csAdmin 未部署最新版') })
      return
    }
    const q = r.queue || {}
    const qBits = []
    if (q.pending) qBits.push('待发 ' + q.pending)
    if (q.failed) qBits.push('失败 ' + q.failed)
    if (q.sent) qBits.push('已发 ' + q.sent)

    const rows = (r.cols || []).map((c) => Object.assign({}, c, {
      state: c.ok ? (c.count + ' 条') : ('❌ ' + (c.err || '不可用'))
    })).concat([
      {
        col: 'groupCode',
        label: '已配素材',
        ok: (r.codeGroups || []).length > 0,
        state: (r.codeGroups || []).length ? r.codeGroups.join(' / ') : '❌ 一个都没配'
      },
      {
        col: 'recentIn',
        label: '最近用户消息',
        ok: true,
        state: ((r.recentIn || []).map((m) => String(m.content || '').slice(0, 8)).join(' ｜ ')) || '没有'
      },
      {
        col: 'queue',
        label: '队列（待发/已发/失败）',
        ok: !q.failed && !q.pending,
        state: qBits.length ? qBits.join(' / ') : '空'
      }
    ])

    // 队列最近一条：定位「素材没发出来」最关键的一行
    const o = r.lastOut
    if (o) {
      const bits = [o.kind + ' · ' + o.status]
      if (o.group) bits.push('素材' + o.group)
      bits.push(o.hasFile ? '有码' : '❌无码')
      bits.push('已等 ' + (o.ageMin >= 0 ? o.ageMin : '?') + '分')
      if (o.retry) bits.push('重试' + o.retry)
      if (o.lastErr) bits.push(o.lastErr.slice(0, 24))
      rows.push({
        col: 'lastOut',
        label: '队列最近一条',
        ok: o.status === 'sent',
        state: bits.join(' · ')
      })
    }

    const qt = r.quota
    if (qt) {
      rows.push({
        col: 'quota',
        label: '下发额度',
        ok: qt.eOk || qt.mOk,
        state: '60秒窗口 ' + (qt.eOk ? '剩' + qt.eN : '过期')
          + ' / 48小时窗口 ' + (qt.mOk ? '剩' + qt.mN : '过期')
      })
    }

    this.setData({
      checks: rows,
      checkMissing: r.missing || [],
      checkVerdict: r.verdict || ''
    })
  },

  onInputText(e) {
    this.setData({ inputText: (e && e.detail && e.detail.value) || '' })
  },

  async onSend() {
    const text = String(this.data.inputText || '').trim()
    if (!text) { U.toast('先写点什么'); return }
    if (!this.data.curOpenid) return
    this.setData({ sending: true })
    const r = await this.call('reply', { token: this.data.token, openid: this.data.curOpenid, text })
    this.setData({ sending: false })
    if (!r || !r.ok) {
      // ⚠️ 失败原因要原样显示：最常见的是「用户 48 小时内没发过消息」，
      //    这是微信的硬限制，必须让运营知道，不能只说「发送失败」
      U.toast((r && r.err) || '发送失败')
      return
    }
    this.setData({ inputText: '' })
    await this.openChatBy(this.data.curOpenid, false)
  }
})
