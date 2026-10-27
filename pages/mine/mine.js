/**
 * 我的页（tab4）：账号区（可选头像昵称）/ 宠物管理 / 相册 / 提醒与授权 / 推荐给养宠好友 / 设置入口 / 客服 / 版本
 * 合规：全站无「登录/注册」字样；无任何联系方式（PRD 5.7）
 *
 * v1.3（设置页与协议合规 PRD）：删掉「宠物 N / 记录 N / 账单 N」统计块与统计计算；
 * 同步状态卡与「关于这个工具」行迁入 pages/settings；设置入口放在推荐好友之后、客服入口之前。
 * 统计块删掉后顺带砍掉了 weights / daily / expenses 三个集合的全量拉取（省 3N 次请求）。
 */
const config = require('../../utils/config')
const store = require('../../utils/store')
const db = require('../../utils/db')
const track = require('../../utils/track')
const U = require('../../utils/util')
const CS = require('../../utils/cs')

Page({
  data: {
    loading: true,
    user: null,
    // 宠物数量：只给「宠物管理」行右侧的「N 只」用（统计块已删，这个字段不能跟着删）
    petCount: 0,
    subBalance: 0,
    remindOnCount: 0,
    // 同步状态：本页只留 syncOk / syncText，异常时渲染一条警示条并引导去设置页
    // （完整状态与诊断面板已迁到 pages/settings）
    syncText: '已同步',
    syncOk: true,
    showProfileSheet: false,
    showTrackPanel: false,
    trackEvents: [],
    // 触点 1（我的页）的 session-from：常驻静态入口，无频次限制
    csFrom: '',
    // 是否有运营后台权限（null = 还没探测）
    csAdmin: null,
    // ⚠️ 白名单是否已锁 —— 只有「通过 + 已锁」才允许把入口常驻显示。
    //    只判 csAdmin 不够：环境变量丢失时 whoami 会对所有人都返回 isAdmin=true
    csAdminLocked: false,
    csAdminDebug: '',
    // 当前微信账号的完整 openid（加第二个客服时要把这串发给运营配白名单）
    myOpenid: '',
    version: config.VERSION
  },

  onLoad() {
    this._offSub = store.on('subChanged', () => this.refresh(true))
  },
  onUnload() {
    this._offSub && this._offSub()
    this._offSub = null
  },
  onShow() {
    // 有写入后强制回源，否则「我的」页统计会停在旧数字上；
    // ⚠️ 共享宠物一律强制：别人新增的照片不会让本地 dirtyVer 变化
    this.refresh(store.isSharedPet() || store.dirtyVer() !== this._seenVer)
  },

  async refresh(force) {
    // 记录本次刷新对应的版本（而非结束时的），刷新期间的写入不能被算作已看到
    const ver = store.dirtyVer()
    try {
      await getApp().ready(2000)
      /**
       * 探测运营权限（决定「客服运营」入口要不要常驻显示）
       * ⚠️ 必须放在 ready() 之后：云环境没初始化就调 callFunction 会直接失败，
       *    失败一次就给这次访问判了「无权限」，入口整趟都不出现
       * ⚠️ 只在还没确认为「白名单已锁的管理员」时才重复探测：
       *    refresh 会被 subChanged 反复触发，没必要每次都打一次网络请求。
       *    （环境变量变动要重启小程序才生效，这个代价可接受 —— 上一版做成缓存短路
       *     把后面依赖新结果的逻辑整段跳过了，排查耗掉好几轮）
       */
      if (this.data.csAdmin !== true || this.data.csAdminLocked !== true) this.probeCsAdmin()

      const pets = await db.listPets(force)
      store.state.pets = pets
      const settings = (await db.getMySettings()) || {}
      const user = store.getUser()
      // 当前宠物：客服触点要把宠物昵称 / 物种带给客服（R6）
      const curPet = store.getCurrentPet()

      /**
       * 只拉「相册张数」和「提醒已开启数」真正需要的数据
       * ⚠️ 以前为了「记录 N / 账单 N」统计块还额外拉了 weights / daily / expenses，
       *    20 只宠物就是 3N = 60 次请求（每次 4 个集合串行等待）。
       *    统计块已按 PRD 删除，这三个循环必须一并去掉 —— 这是本页最实的一笔性能收益。
       */
      let remindOnCount = 0
      /**
       * v1.4a：底部 tab「记账」换成「时光」后，相册页移除、我的页「相册」行删除
       * → 「当前宠物照片数」在本页已无展示处，posts 请求整条去掉（每只宠物省一次读）
       */
      const perPet = await Promise.all(pets.map(async (p) => {
        const h = await db.listBy('health', p._id, { force }).catch(() => [])
        return { petId: p._id, health: h }
      }))
      remindOnCount = perPet.reduce(
        (s, x) => s + x.health.filter((h) => h.remind !== false && h.nextDate).length, 0
      )

      const balance = await db.getSubBalance().catch(() => 0)
      const pending = db.pendingCount()

      // 本页只判断「有没有异常」并给一条指引；具体原因与诊断面板在设置页
      const dead = db.deadList().length

      this.setData({
        loading: false,
        user: {
          nickname: settings.nickname || user.nickname || '',
          avatar: settings.avatar || user.avatar || ''
        },
        petCount: pets.length,
        subBalance: balance || 0,
        remindOnCount,
        syncOk: pending === 0 && dead === 0,
        syncText: pending > 0 ? `${pending} 条待同步` : (dead > 0 ? `${dead} 条同步失败` : '已同步'),
        csFrom: CS.sessionFrom(CS.SOURCES.MINE, curPet && curPet.name, curPet && curPet.species)
      })
      // 页面渲染完预热分享封面（点击时直接命中缓存，转发面板秒开）
      this.warmShareCard()
      this._seenVer = ver
    } catch (e) {
      console.error('我的页加载失败', e)
      this.setData({ loading: false, syncOk: false, syncText: '同步失败' })
    }
  },

  noop() {},

  /* ---------- 客服触点（R1 / R6） ---------- */

  /**
   * bindcontact 回调：会话已打开，记一次 contact_opened
   * ⚠️ 只做埋点，不做任何副作用——会话是微信托管的，这里拿不到用户说了什么。
   *    真正的消息处理在云函数 customer（消息推送）
   */
  onContact(e) {
    const src = CS.SOURCES.MINE
    // ⚠️ 只在「确实打开了会话」时上报：errMsg 非 ok 的都是失败/取消
    const ok = String((e && e.detail && e.detail.errMsg) || '').indexOf('contact:ok') !== -1
    track.track('contact_opened', { source: src, ok: ok ? 1 : 0 })
  },

  goOps() {
    this.setData({ showTrackPanel: false })
    wx.navigateTo({ url: '/pages/ops/ops' })
  },

  /* ---------- 头像昵称（可选设置，微信官方能力） ---------- */
  openProfile() {
    this.setData({ showProfileSheet: true })
  },
  closeProfile() {
    this.setData({ showProfileSheet: false })
  },
  onChooseAvatar(e) {
    this._avatarUrl = e.detail.avatarUrl
    // 先展示本地预览
    this.setData({ 'user.avatar': e.detail.avatarUrl })
  },
  onNickInput(e) {
    this._nickname = e.detail.value
  },
  async saveProfile() {
    const patch = {}
    if (this._avatarUrl) {
      try {
        // 压缩后上传云存储（≤200KB 规则，PRD 6.1）
        const filePath = await this.compressImage(this._avatarUrl)
        const up = await wx.cloud.uploadFile({
          cloudPath: `avatar/${Date.now()}_${Math.floor(Math.random() * 1e4)}.jpg`,
          filePath
        })
        patch.avatar = up.fileID
      } catch (e) {
        console.error('头像上传失败', e)
      }
    }
    if (this._nickname != null && this._nickname !== '') patch.nickname = this._nickname.slice(0, 12)
    if (Object.keys(patch).length) {
      await db.saveMySettings(patch).catch((e) => console.error(e))
      // 同步刷一遍共享成员记录里的昵称头像快照（失败不影响主流程，展示层读 users 表兜底）
      db.syncMyProfile().catch(() => {})
      // 业务漏斗埋点：填昵称/头像这一步（只报布尔，不报内容本身）
      track.track('profile_updated', { withNickname: !!patch.nickname, withAvatar: !!patch.avatar })
      U.toast('已保存')
    }
    this.setData({ showProfileSheet: false })
    this.refresh()
  },
  compressImage(src) {
    return new Promise((resolve) => {
      wx.compressImage({
        src,
        quality: 60,
        success: (r) => resolve(r.tempFilePath),
        fail: () => resolve(src)
      })
    })
  },

  /* ---------- 各入口 ---------- */
  goPets() { wx.navigateTo({ url: '/pages/pet/list/list' }) },
  /** 设置页：同步状态 / 清理缓存 / 协议 / 隐私 / 帮助反馈 / 关于我们 都在这里 */
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }) },

  /* ---------- 推荐给养宠好友（转发小程序本体） ---------- */
  /**
   * 转发内容定制。合规：文案只讲功能，不带任何联系方式（PRD 5.7）
   * 封面图走 recommend-card 离屏 canvas（750×600，5:4）；生成失败就不传 imageUrl，
   * 让微信回落页面默认截图 —— 绝不能让转发面板「点了没反应」
   *
   * 埋点复用白名单里已有的 share_image_generated（channel 区分入口），
   * 不新增事件名，避免还要再部署一次 track 云函数
   */
  async onShareAppMessage() {
    // 信标：这行没打出来 = 点击根本没进到转发回调（热区/按钮问题），不是出图问题
    console.log('[mine] onShareAppMessage hit build=20261023-share')
    let imageUrl = ''
    try {
      const comp = this.selectComponent('#recommendCard')
      if (comp && typeof comp.generate === 'function') imageUrl = await comp.generate()
    } catch (e) {
      console.warn('[mine] 分享封面生成失败', e)
    }
    console.log('[mine] 分享封面 ready=', !!imageUrl)
    track.track('share_image_generated', { channel: 'mine_recommend' })
    return {
      title: '把毛孩子的每一天，都记下来',
      path: '/pages/home/home',
      imageUrl: imageUrl || undefined
    }
  },

  /**
   * 预热分享封面：页面加载完先把卡面画好缓存住
   * 否则首次点击要等 canvas 出图（真机可能几百 ms ~ 1s），转发面板迟迟不出来 = 用户眼里「点了没反应」
   */
  warmShareCard() {
    setTimeout(() => {
      try {
        const comp = this.selectComponent('#recommendCard')
        if (comp && typeof comp.generate === 'function') comp.generate()
      } catch (e) { /* 预热失败不影响任何可见功能，点击时还会再试一次 */ }
    }, 400)
  },

  /**
   * 补一次授权
   * ⚠️ 一次性订阅的每个失败/非授权分支都必须给可见反馈：
   *    只处理 accept、fail 留空，用户眼里就是「点了没反应」，且完全无从定位
   */
  onSubscribe() {
    const tmplId = config.SUBSCRIBE_TEMPLATE_ID
    // 信标：确认新 bundle 在跑（改完组件/页面 js 后真机热重载不一定生效，日志里没有它就是旧代码）
    console.log('[mine] onSubscribe hit build=20261023-sub3 tmplId=', tmplId)
    if (!tmplId) { U.toast('订阅模板未配置'); return }
    // 低版本基础库没有这个 API：直接调会抛 TypeError，页面毫无反馈
    if (typeof wx.requestSubscribeMessage !== 'function') {
      U.toast('当前微信版本过低，请升级微信')
      return
    }
    // ⚠️ 订阅弹窗要等微信网络往返（几百 ms）才出来，中间这段是「真空期」——
    //    没有即时反馈，用户会认为没点上而不停重复点。先给 loading。
    wx.showLoading({ title: '正在发起授权', mask: false })
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: async (res) => {
        wx.hideLoading()
        const st = res && res[tmplId]
        console.log('[mine] subscribe success res=', JSON.stringify(res), 'state=', st)
        if (st === 'accept') {
          require('../../utils/track').track('subscribe_requested', { result: 'accept' })
          // ⚠️ 写库失败不能静默吞：否则用户看到「+1」，云端余额其实没变，到点照样推不出去
          const bal = await db.incrSubBalance(tmplId).catch((e) => {
            console.error('[mine] incrSubBalance 失败', e)
            return null
          })
          if (bal == null) {
            U.toast('授权已记录，但次数写入失败')
          } else {
            U.toast(`授权成功，可用次数 ${bal} 次`)
          }
          this.refresh()
          return
        }
        // accept / reject / ban / filter / cancel：除 accept 外都要说清楚发生了什么
        const MAP = {
          reject: '你拒绝了这次授权，不会产生次数',
          ban: '该模板被微信限制，需要换一个模板',
          filter: '该模板被微信过滤，需要换一个模板',
          cancel: '已取消授权'
        }
        U.toast(MAP[st] || `未获得授权（${st || '未知状态'}）`)
      },
      fail: (err) => {
        wx.hideLoading()
        // ⚠️ 模板 ID 无效 / 没在 mp 后台「我的模板」里选用 / 基础库过低，都会走这里
        console.error('[mine] requestSubscribeMessage fail', err)
        const msg = String((err && err.errMsg) || '')
        if (msg.indexOf('template') > -1 || msg.indexOf('tmplIds') > -1) {
          U.toast('模板无效，确认已选用该模板')
        } else if (msg.indexOf('require') > -1) {
          U.toast('需在点击事件内发起授权')
        } else {
          U.toast('授权失败：' + (msg || '未知错误').slice(-20))
        }
      },
      complete: () => {
        wx.hideLoading() // 兜底：万一 success/fail 都没按预期走，别让 loading 永远转
        console.log('[mine] subscribe complete')
      }
    })
  },

  /* ---------- 同步状态与诊断面板已整体迁到 pages/settings ----------
   * 那边有 onSyncRetry / openDiag / colName / deadSummary / diagTipOf / onRetryDead，
   * 本页只保留「异常时的一条警示条」，点击 goSettings 过去处理。
   * ⚠️ 别再往这里加回来：同步是「设置」性质的信息，不是高频功能（PRD 决策摘要）。
   */

  /* ---------- 埋点自检面板：版本号长按 5 次（PRD 9.6） ---------- */
  onVersionTap() {
    this._vTap = (this._vTap || 0) + 1
    clearTimeout(this._vTimer)
    this._vTimer = setTimeout(() => { this._vTap = 0 }, 2000)
    if (this._vTap >= 5) {
      this._vTap = 0
      this.showTrackPanel()
      this.probeCsAdmin()
    }
  },

  /**
   * 探测当前微信账号有没有运营权限（决定要不要显示「客服运营后台」入口）
   * 双请求：whoami 拿 myOpenid + locked（信息最小化，不回 isAdmin/adminCount）；
   *         probe 是有过闸的权限探测，服务端判定后只回一个布尔。
   * 通过的结果同时写入 app.globalData.csAdminInfo，供 ops 页在探测失败时兜底
   * ⚠️ 探测失败按「无权限」处理（fail-close），不因为报错就放行入口
   */
  async probeCsAdmin() {
    const app = getApp()
    try {
      // ⚠️ 每次都问云端，不拿缓存短路：环境变量改过之后要能立刻反映出来，
      //    否则「配了白名单入口还是老样子」这种假象会一轮一轮耗掉排查时间（已踩）
      //    缓存仍写，供 ops 页在探测失败时兜底
      const [w, p] = await Promise.all([
        wx.cloud.callFunction({ name: 'csAdmin', data: { action: 'whoami' } }),
        wx.cloud.callFunction({ name: 'csAdmin', data: { action: 'probe' } })
      ])
      const who = (w && w.result) || {}
      const pr = (p && p.result) || {}
      const ok = !!pr.ok
      const locked = !!who.locked
      if (ok && app && app.globalData) {
        app.globalData.csAdminInfo = { isAdmin: true, locked, myOpenid: String(who.myOpenid || '') }
        app.globalData.csAdmin = true
      }
      const tail = String(who.myOpenid || '').slice(-6)
      this.setData({
        csAdmin: ok,
        csAdminLocked: locked,
        /**
         * 完整 openid 一并落到 data：要加第二个客服（朋友）时，
         * 只有尾号没法配白名单 —— 必须能把整串发过来。
         * ⚠️ 这是她自己账号的 openid，不涉及越权；入口本身就要连点 5 次才出现。
         */
        myOpenid: String(who.myOpenid || ''),
        // 诊断：面板里直接显示探测结果，一眼看出卡在哪一环
        csAdminDebug: !ok
          ? ('⚠️ 无权限 · ' + (locked
            ? 'openid 不在白名单（我的尾号 ' + (tail || '?') + '）'
            : '白名单未生效：CS_ADMIN_OPENIDS 没读到') + ' · build=' + (who.build || '?'))
          : (locked
            ? ('✅ 有权限 · 白名单已锁 · build=' + (who.build || '?'))
            // 能进但没锁 = 谁点 5 次都能看到入口，只是还要口令。必须显式提醒，别让人以为已经安全了
            : ('⚠️ 能进，但白名单未生效：CS_ADMIN_OPENIDS 没读到，'
              + '任何点开这个面板的人都能看到入口（进后台仍需口令）· build=' + (who.build || '?')))
      })
    } catch (e) {
      // 最常见的原因：csAdmin 云函数还没部署（-501000 / FunctionName not found）
      console.warn('[mine] 运营权限探测失败，入口不显示', e && e.message)
      this.setData({
        csAdmin: false,
        csAdminLocked: false,
        myOpenid: '',
        csAdminDebug: '⚠️ 调用失败（多半是 csAdmin 云函数没部署）：' + ((e && e.errMsg) || (e && e.message) || '未知')
      })
    }
  },

  /** 复制自己的完整 openid：加第二个客服时，必须把整串发给运营去配白名单 */
  onCopyMyOpenid() {
    U.copyText(this.data.myOpenid, '已复制，发给运营')
  },

  /** 点诊断文字把它复制到剪贴板，方便直接粘给我排查 */
  onCopyCsDebug() {
    U.copyText(this.data.csAdminDebug)
  },
  showTrackPanel() {
    try {
      const q = wx.getStorageSync('tj_track_queue') || []
      this.setData({
        showTrackPanel: true,
        trackEvents: q.slice(-20).reverse().map((e) => ({
          eventId: e.eventId.slice(0, 8),
          event: e.event,
          time: U.fmtDate(new Date(e.clientTs)).slice(5) + ' ' + U.pad(new Date(e.clientTs).getHours()) + ':' + U.pad(new Date(e.clientTs).getMinutes()),
          status: '待上报',
          critical: e.critical
        }))
      })
    } catch (e) {
      this.setData({ showTrackPanel: true, trackEvents: [] })
    }
  },
  closeTrackPanel() {
    this.setData({ showTrackPanel: false })
  }
})
