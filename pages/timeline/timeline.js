/**
 * 时光页（tab3 承载页，v1.4a）：时间线 / 相册两个分段
 *
 * v1.4a：底部 tab「记账」换成「时光」，本页从二级页升为 tab 承载页：
 * - 顶部加「足迹 / 光影」分段控件，默认足迹；光影 = components/album-grid（原 album 页平移）
 * - 原右上角「相册 ›」按钮删除；分享长图图标只在「足迹」分段显示
 * - 宠物切换上移到导航栏中间（页面级：切一次，两个分段数据同步换）
 * - ⚠️ 本页是 tabBar 页面，**不设返回按钮**（页面栈恒为 1 且底部有 tabBar，返回按钮无用）
 *
 * v2.1（时间线图文与相册）：
 * - 新增「图文」筛选与发图文弹层（post-sheet）
 * - 图片来自 posts 集合，与其它记录同列混排
 * - 长按菜单：删除（作者本人 + owner 才能删，否则置灰说明）+ 举报（选原因 → 写 reports 集合）
 * - 分享长图前必须剔掉 visibility==='private' 的条目（红线第 10 条）
 */
const store = require('../../utils/store')
const db = require('../../utils/db')
const U = require('../../utils/util')
const TL = require('../../utils/timeline')
const track = require('../../utils/track')
const media = require('../../utils/media')

const PAGE_SIZE = 20
const DRAFT_KEY = 'tj_post_draft'

Page({
  data: {
    loading: true,
    error: false,
    pet: null,
    /**
     * 顺序即曝光权重：「图文」是本期主推入口，放第 2 位（不滑动就能看到）；
     * 其余是已上线功能，滑一下无妨。chips 行是横向滚动，后排不会丢，只是要滑。
     * ⚠️ pickTypeThenAdd 的 ActionSheet 选项也取这个数组，顺序同源，别在别处写死枚举
     */
    filters: [
      { key: 'all', name: '全部' },
      { key: 'moment', name: '图文' },
      { key: 'vaccine', name: '疫苗' },
      { key: 'deworm', name: '驱虫' },
      { key: 'checkup', name: '体检' },
      { key: 'weight', name: '体重' },
      { key: 'daily', name: '日常' }
    ],
    filter: 'all',
    groups: [],
    shownCount: 0,
    hasMore: false,
    isEmpty: false,
    filterEmpty: false,
    /** 当前分段：timeline（默认） / album */
    seg: 'timeline',
    /** 切换宠物弹层（设计稿 albsw：点导航栏中间的宠物名唤起） */
    showSwitch: false,
    pets: [],
    multiPet: false,
    /** { [petId]: 照片张数 }，供 pet-switcher 显示「N 张 / 还没有照片」 */
    petCounts: {},
    delItem: null,
    delBlocked: false,
    delTip: '',
    /** 长按菜单里是否显示「举报」（只对别人发的图文开放） */
    canReport: false,
    showDaily: false,
    dailyTag: '',
    /** 全部日常类型选择弹层（FAB「记一条 → 日常」入口，components/daily-picker，与首页共用配置） */
    showDailyPicker: false,
    showPost: false,
    postMax: 3,
    postVia: 'timeline',
    postPetName: '',
    draftCount: 0,
    ui: { statusBarHeight: 20, navBarHeight: 44, menuRight: 90, menuWidth: 87 },
    /** 导航行右缘距屏幕右边（= 胶囊左缘 - 8px），防止压进胶囊被盖住 */
    shareRight: 90,
    /**
     * 吸顶 top（px）。三层吸顶：沉浸式导航 → 分段行 → chips/月份
     * - segStickyTop     = 导航总高（状态栏 + 导航行）
     * - chipsStickyTop   = 导航总高 + 分段行高 48
     * - monthStickyTop   = 导航总高 + 分段行高 48 + chips 高 48（时间线分段）
     * - albMonthStickyTop= 导航总高 + 分段行高 48（相册分段没有 chips 行）
     */
    segStickyTop: 0,
    chipsStickyTop: 0,
    monthStickyTop: 0,
    albMonthStickyTop: 0,
    /** 导航栏中间「宠物切换器」的 top（在状态栏之下的导航行里垂直居中） */
    petswTop: 0,
    /** chips 横向滚动时是否还有右侧内容（控制右缘渐隐显隐） */
    chipsFadeIn: false
  },

  onLoad() {
    this._all = []
    this._page = 0
    // 各分段各自的滚动位置（切换分段时互相不影响）
    this._scrollTop = { timeline: 0, album: 0 }
    this._curScrollTop = 0
    // 每只宠物的照片数缓存（切换弹层里显示）
    this._counts = {}
    const ui = U.getUI()
    const navTotal = ui.statusBarHeight + ui.navBarHeight
    // 分段行高与 chips 行高都是 48px（96rpx），写死在这里 —— 改样式必须同步改这两个数
    const SEG_H = 48
    const CHIPS_H = 48
    this.setData({
      ui,
      shareRight: ui.menuRight + (ui.menuWidth || 87) + 8,
      segStickyTop: navTotal,
      chipsStickyTop: navTotal + SEG_H,
      monthStickyTop: navTotal + SEG_H + CHIPS_H,
      albMonthStickyTop: navTotal + SEG_H,
      // 切换器高 48rpx = 24px，在导航行里垂直居中
      petswTop: ui.statusBarHeight + (ui.navBarHeight - 24) / 2
    })
  },

  onPageScroll(e) {
    this._curScrollTop = (e && e.scrollTop) || 0
  },

  /** chips 是否超出屏宽（超出才显示右缘渐隐）；只在首屏量一次，chips 是静态枚举 */
  onReady() {
    this.measureChips()
  },

  measureChips() {
    wx.createSelectorQuery().in(this)
      .select('.tl-chips-sw').boundingClientRect()
      .select('.tl-chips-in').boundingClientRect()
      .exec((res) => {
        const box = res[0] || {}
        const inner = res[1] || {}
        const max = Math.max(0, (inner.width || 0) - (box.width || 0))
        this._chipsMax = max
        this.setData({ chipsFadeIn: max > 8 })
      })
  },

  /** 滚到底就把渐隐收掉，别盖在最后一个 chip 上 */
  onChipsScroll(e) {
    const max = this._chipsMax || 0
    if (!max) return
    const left = (e.detail && e.detail.scrollLeft) || 0
    const fade = left < max - 8
    if (fade !== this.data.chipsFadeIn) this.setData({ chipsFadeIn: fade })
  },

  onShow() {
    /**
     * ⚠️ 强制回源，不依赖 isSharedPet()：
     *    dirtyVer 只反映「我自己的写入」，别人新增记录本地无从感知；
     *    memberCount 又是缓存字段，判错就静默不刷新 —— 代价是看不到别人的内容，比多几次读代价大得多。
     *
     * ⚠️ v1.4a（本页升级为 tab 页后）：切 tab 回来**不 reset**。
     *    reset 会回到第一页并把滚动位置丢掉，作为高频入口的 tab 这是明显的体验倒退；
     *    只在「首次进入 / 宠物变更 / 下拉」时 reset，其余保留分页与滚动位置
     */
    const pet = store.getCurrentPet()
    const petChanged = !this._petId || !!(pet && pet._id && pet._id !== this._petId)
    const pets = store.state.pets || []
    this.setData({ pets, multiPet: pets.length > 1 })
    this.load(petChanged, true)
    this.refreshDraftTip()
    // 相册分段：已加载过就跟着回源（keepCount 保留已展示条数，避免回顶）；没加载过不动
    const grid = this.selectComponent('#albumGrid')
    if (grid) {
      if (petChanged) grid.reload()
      else if (grid._loaded) grid.load(true, true)
    }
  },

  onPullDownRefresh() {
    // 下拉刷新当前分段：相册分段的数据在组件里，得转发过去（否则下拉了相册不动）
    const stop = () => wx.stopPullDownRefresh()
    if (this.data.seg === 'album') {
      const grid = this.selectComponent('#albumGrid')
      if (grid) { grid.load(true).finally(stop); return }
    }
    this.load(true, true).finally(stop)
  },

  async load(reset, force) {
    // 记录本次加载对应的版本（而非结束时的），加载期间的写入不能被算作已看到。
    // 挂在实例上传递：applyView 是独立方法，拿不到这里的局部变量
    this._pendingVer = store.dirtyVer()
    if (reset) { this._page = 0 }
    this.setData({ loading: !this._all.length, error: false })
    try {
      await getApp().ready(2000)
      const pet = store.getCurrentPet()
      if (!pet) {
        this.setData({ loading: false, isEmpty: true, pet: null })
        return
      }
      // 首次进入 / 下拉 / 宠物变更 / 强制回源时全量归并
      // ⚠️ v1.4a：force 也归并（tab 高频进入必须能看到别人新记的内容），
      //    但 reset 单独控制「是否回到第一页」—— 两者解耦，才能既回源又不回顶
      if (reset || force || !this._petId || this._petId !== pet._id) {
        this._petId = pet._id
        const [health, weights, daily, posts] = await Promise.all([
          db.listBy('health', pet._id, { force }),
          db.listBy('weights', pet._id, { force }),
          db.listBy('daily', pet._id, { force }),
          // posts 单独失败不该拖垮整页：图文拉不到就先只看记录
          db.listPosts(pet._id, { force }).then((list) => {
            // 排障信标：共享场景下「别人发的看不到」时，先看这里返回的条数对不对
            console.log('[timeline] posts 返回', (list || []).length, '条 force=', !!force)
            return list
          }).catch((e) => {
            console.error('[timeline] listPosts 失败', e)
            return []
          })
        ])
        this._weights = weights
        this._all = TL.merge(pet, { health, weights, daily, posts })
      }
      this.applyView(reset)
    } catch (e) {
      console.error('时间线加载失败', e)
      this.setData({ loading: false, error: true })
    }
  },

  /** 应用筛选 + 分页切片 */
  applyView(reset) {
    const filtered = TL.filterItems(this._all, this.data.filter === 'deworm' ? 'deworm' : this.data.filter)
    // 驱虫筛选合并体内/体外
    const view = this.data.filter === 'deworm'
      ? this._all.filter((it) => it.type === 'dewormIn' || it.type === 'dewormOut')
      : filtered
    const count = reset ? PAGE_SIZE : (this.data.shownCount + PAGE_SIZE)
    const shown = view.slice(0, count)
    this._page = Math.ceil(shown.length / PAGE_SIZE)
    const pets = store.state.pets || []
    this.setData({
      loading: false,
      groups: TL.groupByMonth(shown),
      shownCount: shown.length,
      hasMore: shown.length < view.length,
      isEmpty: this._all.length === 0,
      filterEmpty: this._all.length > 0 && view.length === 0,
      pet: store.getCurrentPet(),
      pets,
      multiPet: pets.length > 1
    })
    this._seenVer = this._pendingVer
  },

  onFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.k })
    this.applyView(true)
  },

  /**
   * 切换分段：各分段保留自己的滚动位置与数据（PRD v1.4a）
   * ⚠️ 页面只有一个滚动容器，切走前记下 scrollTop，切回来用 pageScrollTo 恢复；
   *    目标分段内容比记录值短时微信会自动贴到底部，不需要额外 clamp
   */
  onSeg(e) {
    const to = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.k) || ''
    if (!to || to === this.data.seg) return
    this._scrollTop[this.data.seg] = this._curScrollTop
    this.setData({ seg: to }, () => {
      wx.pageScrollTo({ scrollTop: this._scrollTop[to] || 0, duration: 0 })
    })
  },

  onReachBottom() {
    // 相册分段的分页在组件里：组件监听不到页面触底，由页面转发
    if (this.data.seg === 'album') {
      const grid = this.selectComponent('#albumGrid')
      if (grid) grid.loadMore()
      return
    }
    if (this.data.hasMore) this.applyView(false)
  },

  onRetry() { this.load(true) },

  /* ---- 切换宠物（页面级：切一次，足迹 / 光影两个分段数据同步换） ---- */
  /**
   * 打开切换弹层（设计稿 albsw）
   * ⚠️ 用 pet-switcher 而不是 wx.showActionSheet：系统面板只能显示一行纯文字，
   *    放不下头像 / 品种年龄 / 照片数，也跟首页、健康、记账的切换体验不一致
   */
  async openSwitcher() {
    const pets = this.data.pets || []
    if (pets.length < 2) return
    this.setData({ showSwitch: true })
    // 每只宠物的照片数（弹层里显示「N 张 / 还没有照片」）。
    // 只在缺的宠物上拉一次并缓存；失败降级为「不显示张数」，不阻塞切换
    const miss = pets.filter((p) => this._counts[p._id] == null)
    if (!miss.length) { this.setData({ petCounts: Object.assign({}, this._counts) }); return }
    await Promise.all(miss.map(async (p) => {
      const list = await db.listPosts(p._id, {}).catch(() => [])
      let n = 0
      ;(list || []).forEach((x) => { n += ((x && x.images) || []).length })
      this._counts[p._id] = n
    }))
    this.setData({ petCounts: Object.assign({}, this._counts) })
  },

  onSwitchClose() { this.setData({ showSwitch: false }) },

  onSwitchSelect(e) {
    const id = (e && e.detail && e.detail.petId) || ''
    if (!id) return
    store.setCurrentPet(id)
    this.setData({ showSwitch: false })
    // 两个分段都回到顶部重来：宠物是页面级的，不能出现「相册换了、时间线还是旧的」
    this._scrollTop = { timeline: 0, album: 0 }
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    this.load(true, true)
    const grid = this.selectComponent('#albumGrid')
    if (grid) grid.reload()
    this.refreshDraftTip()
  },

  /* ---- 分享长图：私密条目绝不进长图（红线第 10 条） ---- */
  onShare() {
    if (!this._all.length) return
    const pet = store.getCurrentPet()
    const privates = this._all.filter((it) => it.type === 'moment' && it.visibility === 'private').length
    const records = this._all.filter((it) => !(it.type === 'moment' && it.visibility === 'private'))
    if (privates) U.toast(`已跳过 ${privates} 条私密内容`)
    this.selectComponent('#sharePop').generate({
      source: 'timeline',
      pet,
      records,
      // 图文条目的照片由 share-pop 直接从 records 里取（图跟卡片走，不做独立照片墙）
      weights: (store.getCurrentPet() && this._weights) || []
    })
  },

  /* ---- 点图看大图（full 档；左右滑 + 长按保存由微信自带） ---- */
  async onPreview(e) {
    const d = e.detail || {}
    const it = d.item || {}
    const ids = (it.images || []).map((im) => im.full).filter(Boolean)
    if (!ids.length) return
    const want = Math.min(Math.max(Number(d.index) || 0, 0), ids.length - 1)
    // ⚠️ previewImage 只吃 http(s)：直接传 cloud:// fileID 会 fail/白屏（image 组件支持，容易误判）
    const all = await media.toTempUrls(ids)
    const pairs = []
    all.forEach((u, k) => { if (u) pairs.push({ u, k }) })
    if (!pairs.length) { U.toast('图片加载失败，稍后再试'); return }
    const hit = pairs.filter((p) => p.k === want)[0] || pairs[0]
    wx.previewImage({ urls: pairs.map((p) => p.u), current: hit.u })
    track.track('photo_viewed', { petId: this._petId || '', imgCount: pairs.length })
  },

  onTimelineEdit(e) {
    const it = e.detail.item
    // 日常记录（洗澡/换粮）暂不支持编辑弹层，长按可删除
    if (it.type === 'daily') {
      U.toast('日常记录可长按删除')
      return
    }
    // 图文不支持编辑（PRD 明确本轮只做删除），点卡片已经是看大图
    if (it.type === 'moment') return
    this.selectComponent('#recordSheet').open({ mode: 'edit', col: it.col, record: it })
  },

  /* ---- 长按菜单 ---- */
  onItemDel(e) {
    const it = e.detail.item
    if (!it || !it.col) return
    const pet = store.getCurrentPet()
    const memberCount = (pet && pet.memberCount) || 1
    // 删除权收紧为「作者本人 + owner」：别人记的删不掉，菜单直接置灰说明，别让用户点了才报错
    const blocked = it.col === 'posts' ? it.canDelete === false : false
    const delTip = memberCount > 1
      ? `删除后其他 ${memberCount - 1} 位成员也将看不到，时间线和统计同步更新`
      : '删除后时间线和统计会同步更新'
    // 举报只对「别人发的图文」开放（自己举报自己没意义，云端也会拒绝）
    // ⚠️ 这里只是「别显示没用的入口」，真正的权限判断在服务端
    const myOpenid = (getApp() && getApp().globalData && getApp().globalData.openid) || ''
    const canReport = it.col === 'posts' && !!it.createdBy && it.createdBy !== myOpenid
    this.setData({ delItem: it, delBlocked: blocked, delTip, canReport })
  },
  onDelCancel() {
    this.setData({ delItem: null, delBlocked: false })
  },
  onDelTap() {
    if (this.data.delBlocked) {
      U.toast('只能删除自己记录的内容')
      return
    }
    this.onDelConfirm()
  },
  async onDelConfirm() {
    const it = this.data.delItem
    if (!it || this._deleting) return
    this._deleting = true
    try {
      const pet = store.getCurrentPet()
      const petId = pet && pet._id
      const byOwner = !!pet && pet.myRole === 'owner'
      if (it.col === 'posts') {
        await db.removePost(petId, it._id)
        track.track('post_deleted', { petId, byOwner })
      } else if (it.col === 'health') {
        // 删除健康记录 → 连带删掉它产生的那笔花销（口径同 record-sheet.doDelete）
        const exps = await db.listBy('expenses', petId).catch(() => [])
        const exp = exps.find((x) => x.sourceType === 'health' && x.sourceId === it._id) || null
        await db.removeRecord('health', petId, it._id)
        if (exp) await db.removeRecord('expenses', `${petId}_${(it.date || '').slice(0, 7)}`, exp._id)
      } else {
        await db.removeRecord(it.col, petId, it._id)
      }
      this.setData({ delItem: null, delBlocked: false })
      U.toast('已删除')
      this.load(true, true)
    } catch (err) {
      console.error('时间线删除失败', err)
      // 403 必须翻成人话（「只能删除自己记录的内容」），别只弹「删除失败」
      U.toastErr(err, '删除失败，请重试')
    } finally {
      this._deleting = false
    }
  },

  /* ---- 举报（PRD《内容安全与风控》10.1） ---- */
  /**
   * 举报原因：系统 ActionSheet，五个固定选项，不做自由输入
   * （自由输入本身就是要审核的内容，等于给自己加负担）
   */
  onReportTap() {
    const it = this.data.delItem
    if (!it || !it._id) return
    const REASONS = [
      { key: 'porn', name: '色情低俗' },
      { key: 'violence', name: '暴力血腥' },
      { key: 'illegal', name: '违法违规' },
      { key: 'abuse', name: '辱骂引战' },
      { key: 'other', name: '其他' }
    ]
    wx.showActionSheet({
      itemList: REASONS.map((r) => r.name),
      success: async (res) => {
        const hit = REASONS[res.tapIndex]
        if (!hit) return
        this.setData({ delItem: null, delBlocked: false, canReport: false })
        try {
          const r = await db.reportPost(this._petId, it._id, hit.key)
          track.track('content_reported', { petId: this._petId || '', reason: hit.key })
          // ⚠️ takenDown=false 不代表没记上：只是还没到阈值（2 人 / owner）
          U.toast(r && r.takenDown
            ? '已收到，这条内容已暂时下架，我们会核实'
            : '已收到，我们会尽快核实')
          this.load(true, true)
        } catch (err) {
          console.error('[timeline] 举报失败', err)
          U.toastErr(err, '举报失败，请重试')
        }
      }
    })
  },

  /* ---- 申诉：我认为这是误判（PRD 第 11 节，宠物垂直场景必须有这个出口） ---- */
  async onItemAppeal(e) {
    const it = (e && e.detail && e.detail.item) || null
    if (!it || !it._id) return
    const done = await new Promise((resolve) => {
      wx.showModal({
        title: '申诉这条内容',
        content: '说明一下这张图/这段文字的情况，我复核后会恢复它。',
        editable: true,
        placeholderText: '例如：这是绝育手术后的伤口照片',
        confirmText: '提交',
        cancelText: '再想想',
        success: (r) => resolve(r.confirm ? (r.content || '') : null),
        fail: () => resolve(null)
      })
    })
    if (done === null) return
    try {
      await db.appealPost(this._petId, it._id, done)
      track.track('appeal_submitted', { petId: this._petId || '' })
      U.toast('申诉已提交，我会尽快复核')
      this.load(true, true)
    } catch (err) {
      console.error('[timeline] 申诉失败', err)
      U.toastErr(err, '申诉失败，请重试')
    }
  },

  onSheetSaved() { this.load(true) },

  /* ---- 发图文 ---- */
  refreshDraftTip() {
    let n = 0
    try {
      const d = wx.getStorageSync(DRAFT_KEY)
      const pet = store.getCurrentPet()
      if (d && d.petId && pet && d.petId === pet._id) {
        n = (d.picks || []).length + ((d.content || '').trim() ? 1 : 0)
      }
    } catch (e) { /* 忽略 */ }
    this.setData({ draftCount: n })
  },
  onResumeDraft() {
    this.openPost()
  },
  openPost() {
    const pet = store.getCurrentPet()
    if (!pet || !pet._id) { U.toast('先创建宠物档案，才能发图文'); return }
    const d = (() => {
      try { return wx.getStorageSync(DRAFT_KEY) || {} } catch (e) { return {} }
    })()
    // 草稿里可能存着相册入口选的 9 张，别因为从时间线进来就被砍成 3 张
    const drafted = (d.petId === pet._id) ? (d.picks || []).length : 0
    this.setData({
      showPost: true,
      postMax: drafted > 3 ? 9 : 3,
      postVia: 'timeline',
      postPetName: pet.name || ''
    })
  },
  onPostClose() {
    this.setData({ showPost: false })
    this.refreshDraftTip()
  },
  onPostSaved() {
    this.setData({ showPost: false, draftCount: 0 })
    U.toast('记好了')
    this.load(true, true)
  },

  /* ---- 记一条：按当前筛选打开对应弹层（「全部」/「体重」先让用户选类型） ---- */
  onAddRecord() {
    const pet = store.getCurrentPet()
    if (!pet || !pet._id) { U.toast('先创建宠物档案，才能记一条'); return }
    const f = this.data.filter
    if (f === 'all' || f === 'weight') { this.pickTypeThenAdd(); return }
    this.openAddSheet(f)
  },
  /** 「全部」筛选：先选类型（选项取筛选 chips 并排除 weight——体重只在档案页/首页宫格记录） */
  pickTypeThenAdd() {
    const opts = this.data.filters.filter((x) => x.key !== 'all' && x.key !== 'weight')
    wx.showActionSheet({
      itemList: opts.map((o) => o.name),
      success: (res) => {
        const hit = opts[res.tapIndex]
        if (hit) this.openAddSheet(hit.key)
      }
    })
  },
  /**
   * 按类型打开对应弹层；驱虫再分体内/体外
   * ⚠️ 日常（PRD《随手记自定义常用》B5）：不再直开备注弹层，先开 daily-picker
   *    （7 类型宫格 + 编辑常用），选完类型再开备注弹层预选 —— 与首页「···」同一份配置
   */
  openAddSheet(key) {
    if (key === 'moment') { this.openPost(); return }
    if (key === 'daily') {
      this.setData({ showDailyPicker: true })
      return
    }
    if (key === 'deworm') { this.pickDewormThenAdd(); return }
    const sheet = this.selectComponent('#recordSheet')
    if (!sheet) return
    if (key === 'vaccine') sheet.open({ mode: 'health', hType: 'vaccine' })
    else if (key === 'checkup') sheet.open({ mode: 'health', hType: 'checkup' })
  },
  pickDewormThenAdd() {
    const subs = [
      { key: 'dewormIn', name: '体内驱虫' },
      { key: 'dewormOut', name: '体外驱虫' }
    ]
    wx.showActionSheet({
      itemList: subs.map((s) => s.name),
      success: (res) => {
        const hit = subs[res.tapIndex]
        if (!hit) return
        const sheet = this.selectComponent('#recordSheet')
        if (sheet) sheet.open({ mode: 'health', hType: hit.key })
      }
    })
  },
  onDailyClose() { this.setData({ showDaily: false }) },
  onDailySaved() {
    this.setData({ showDaily: false })
    this.load(true, true)
  },

  /* ---- 日常类型选择弹层（daily-picker，与首页「···」共用） ---- */
  onDailyPickerClose() { this.setData({ showDailyPicker: false }) },
  /** 选完类型 → 关选择层，开备注弹层并预选该类型（与首页 onDailyPickerPick 同款） */
  onDailyPickerPick(e) {
    const key = (e && e.detail && e.detail.key) || ''
    this.setData({ showDailyPicker: false, showDaily: true, dailyTag: key })
  },
  /**
   * 编辑常用保存成功的通知。时光页没有常用胶囊要刷，无需处理；
   * 配置在组件里已落云端，首页下次 onShow 的 resolveQuick 自然拿到新值
   */
  onDailyConfigured() {},
  goHome() { wx.switchTab({ url: '/pages/home/home' }) }
})
