/**
 * 健康页（tab2）：顶部四类 chip 切换 — 全部 / 疫苗 / 驱虫（体内·体外二级）/ 体检
 * 体重不在此页展示：体重只在档案编辑页与首页快捷宫格记录，历史在时间线页看
 * 排序：全部/疫苗/驱虫/体检按下次日期升序（有 nextDate 在前）
 */
const config = require('../../utils/config')
const store = require('../../utils/store')
const db = require('../../utils/db')
const U = require('../../utils/util')
const CS = require('../../utils/cs')

/** 健康记录四类在卡片上的图标 / 标签 / 日期文案（模板 hcard 的唯一数据源） */
const TYPE_UI = {
  vaccine: { icClass: 'vac', icText: '💉', tagClass: 'tag-vac', tagText: '疫苗', dateLabel: '接种日期' },
  dewormIn: { icClass: 'dew', icText: '🐛', tagClass: 'tag-dew', tagText: '体内', dateLabel: '驱虫日期' },
  dewormOut: { icClass: 'dew', icText: '🐛', tagClass: 'tag-home', tagText: '体外', dateLabel: '驱虫日期' },
  checkup: { icClass: 'ck', icText: '🩺', tagClass: 'tag-ck', tagText: '体检', dateLabel: '体检日期' }
}

const TABS = [
  { key: 'all', name: '全部' },
  { key: 'vaccine', name: '疫苗' },
  { key: 'deworm', name: '驱虫' },
  { key: 'checkup', name: '体检' }
]

Page({
  data: {
    loading: true,
    error: false,
    pet: null,
    pets: [],
    petView: null,
    tabs: TABS,
    tab: 'all',
    dewormTab: 'dewormIn',
    allList: [],
    allGroups: [],
    /** 自定义导航参数（U.getUI() 量胶囊，同时光页） */
    ui: { statusBarHeight: 20, navBarHeight: 44, menuRight: 90, menuWidth: 87 },
    /** 导航行右缘距屏幕右边（= 胶囊左缘 - 8px），分享图标避让胶囊 */
    shareRight: 90,
    /** 固定头（状态栏 + 导航行 + 宠物名片 + tabs）的实测高度 px；列表区 padding-top 用 */
    headH: 0,
    /**
     * 顶部悬浮分组条的 top（= 固定头高度 headH，量出来后同步）。
     * ⚠️ 页级 position:sticky 在这个基础库/真机上实测两次都不生效，吸顶全走 JS：
     *    量分组位置 → onPageScroll → .grp-float 固定条显示当前分组
     */
    grpStickyTop: 0,
    /** 顶部悬浮分组条内容：{ title, color }，null = 不显示 */
    floatGrp: null,
    /**
     * 当前 tab 的记录条数：分享图标「有数据才显示」就靠它
     * ⚠️ 四个 tab 都可能有数据（驱虫二级切换后还会变），所以要随 tab / 二级 tab 重算
     */
    shareCount: 0,
    vaccines: [],
    deworms: [],
    checkups: [],
    dewormShown: [],
    weightsView: [],
    showSwitcher: false,
    anyRemindFailed: false,
    // 客服触点 4：无健康记录 / 异宠时出现（每人每周 ≤1 次）
    csUnknown: false,
    csFromUnknown: ''
  },

  onShow() {
    // 有写入（本页或别处）后强制回源，否则切回 tab 会一直吃旧缓存
    this.refresh(store.dirtyVer() !== this._seenVer)
  },

  onLoad() {
    // 切换宠物后本页要跟着换数据（tab 页常驻，无需 onUnload 解绑）
    store.on('petChanged', () => this.refresh(true))
    // 自定义导航：量状态栏 / 导航行 / 胶囊（同时光页 .tl-nav 的做法）
    const ui = U.getUI()
    this.setData({
      ui,
      // 分享图标贴着胶囊左缘留 8px
      shareRight: ui.menuRight + (ui.menuWidth || 87) + 8
    })
  },

  onPullDownRefresh() {
    this.refresh(true).finally(() => wx.stopPullDownRefresh())
  },

  async refresh(force) {
    // 记下「本次刷新对应的版本」而不是结束时的版本：刷新期间若又发生写入，
    // 那些新数据这次并没读到，下次 onShow 必须重新回源
    const ver = store.dirtyVer()
    this.setData({ loading: !this.data.pet, error: false })
    try {
      await getApp().ready(2000)
      const pets = await db.listPets(force)
      store.state.pets = pets
      const pet = store.getCurrentPet()
      if (!pet) {
        this.setData({ loading: false, pet: null })
        // 没宠物也要量固定头高度：空态视图要给 fixed 头让位
        this.measureGroups()
        return
      }
      const [health, weights] = await Promise.all([
        db.listBy('health', pet._id, { force }),
        db.listBy('weights', pet._id, { force })
      ])
      this._health = health
      this._weights = weights
      const today = U.todayStr()

      const sortHealth = (a, b) => {
        // 已结案（续记后旧记录 / 用户关了提醒）沉底：它们的 nextDate 更早，
        // 不单独排序就会永远占据列表第一屏，把真正待办的那条挤下去
        const aDone = a.remind === false
        const bDone = b.remind === false
        if (aDone !== bDone) return aDone ? 1 : -1
        if (a.nextDate && b.nextDate) return a.nextDate.localeCompare(b.nextDate)
        if (a.nextDate) return -1
        if (b.nextDate) return 1
        return b.date.localeCompare(a.date)
      }
      const decorate = (h) => {
        let badge = ''
        let badgeRed = false
        let subText = ''
        if (h.nextDate) {
          const days = U.daysBetween(today, h.nextDate)
          if (h.remind === false) {
            // 已结案：这一针打过了（续记会把旧记录关提醒）/ 用户主动关了提醒。
            // 文案要两种场景都成立，不能写死「已记录新的接种」
            badge = '提醒已关'
            subText = '不再提醒'
          } else if (days < 0) {
            badge = `逾期 ${-days} 天`; badgeRed = true; subText = '该安排了'
          } else if (days === 0) {
            // 文案口径与首页倒计时卡保持一致：0 天不写「0 天后」，那是没人说得通的表述
            badge = '今天到期'; subText = '就是今天'
          } else {
            badge = `${days} 天后`; subText = `还有 ${days} 天`
          }
        } else {
          subText = '未设置下次日期'
        }
        const typeName = { vaccine: '疫苗', dewormIn: '体内驱虫', dewormOut: '体外驱虫', checkup: '体检' }[h.type] || '健康'
        // 卡片模板（wxml 里的 hcard）需要的展示字段，四类共用一套标记
        const ui = TYPE_UI[h.type] || TYPE_UI.vaccine
        return {
          ...h,
          nameText: h.name || typeName,
          icClass: ui.icClass,
          icText: ui.icText,
          tagClass: ui.tagClass,
          tagText: h.type === 'vaccine' ? (h.dose || '') : ui.tagText,
          dateLabel: ui.dateLabel,
          dateText: h.date,
          costText: h.cost > 0 ? `¥${U.fen2yuan(h.cost)}` : '',
          nextText: h.nextDate || '—',
          noteText: h.note || '',
          remindOn: h.remind !== false,
          authText: `已授权 ${h.authCount || 0} 次`,
          badge,
          badgeRed,
          subText,
          subLabel: h.type === 'vaccine' ? '下次接种' : h.type === 'checkup' ? '下次体检' : '下次驱虫'
        }
      }
      const vaccines = health.filter((h) => h.type === 'vaccine').sort(sortHealth).map(decorate)
      const deworms = health.filter((h) => h.type === 'dewormIn' || h.type === 'dewormOut').sort(sortHealth).map(decorate)
      const checkups = health.filter((h) => h.type === 'checkup').sort(sortHealth).map(decorate)
      // 「全部」= 三类健康记录合并，同一次序（有 nextDate 在前）
      const allList = [...vaccines, ...deworms, ...checkups].sort(sortHealth)
      // v1.5 用户反馈：全部 tab 是一长串扁平列表，滚两屏就不知道自己在看哪类
      // → 按类型分段，wxml 里给分组头加 sticky 吸顶；颜色沿用各类型的语义色
      const allGroups = [
        { key: 'vaccine', name: '疫苗', color: '#4A7DE0', list: vaccines },
        { key: 'deworm', name: '驱虫', color: '#1E9A80', list: deworms },
        { key: 'checkup', name: '体检', color: '#7B61FF', list: checkups }
      ].filter((g) => g.list.length)

      // 驱虫二级默认落在「有记录的那一类」上，避免默认页是空的
      let dewormTab = this.data.dewormTab || 'dewormIn'
      if (!deworms.some((d) => d.type === dewormTab)) {
        dewormTab = deworms.some((d) => d.type === 'dewormIn') ? 'dewormIn'
          : deworms.some((d) => d.type === 'dewormOut') ? 'dewormOut' : dewormTab
      }
      const dewormShown = deworms.filter((d) => d.type === dewormTab)

      // 客服触点 4：这只宠物还没有任何健康记录时（异宠用户尤其需要）
      // 频次每人每周 ≤1 次 —— 同样用 peek 只读 + 展示即占位的写法，
      // 避免 refresh 反复触发把名额吃掉
      const csUnknown = !allList.length && (this._csUnknownShown || CS.peek(CS.SOURCES.HEALTH))
      if (csUnknown && !this._csUnknownShown) {
        this._csUnknownShown = true
        CS.canShow(CS.SOURCES.HEALTH)
      }

      this.setData({
        loading: false,
        pet,
        pets,
        petView: {
          name: pet.name,
          // 无头像由 pet-avatar 组件按物种 emoji 兜底
          avatar: pet.avatar || '',
          avatarSmall: pet.avatarSmall || '',
          info: [pet.breed, U.formatAge(pet.birthday)].filter(Boolean).join(' · ')
        },
        tabs: TABS.map((t) => ({
          ...t,
          count: t.key === 'all' ? allList.length
            : t.key === 'vaccine' ? vaccines.length
              : t.key === 'deworm' ? deworms.length : checkups.length
        })),
        allList,
        allGroups,
        // 分享图标显隐：按当前 tab 的记录条数（locals 是最新的，别读 this.data）
        shareCount: (this.data.tab === 'vaccine' ? vaccines.length
          : this.data.tab === 'deworm' ? dewormShown.length
            : this.data.tab === 'checkup' ? checkups.length : allList.length),
        vaccines,
        deworms,
        checkups,
        dewormTab,
        dewormShown,
        anyRemindFailed: health.some((h) => h.remindFailed && !h.reminded),
        csUnknown,
        csFromUnknown: CS.sessionFrom(CS.SOURCES.HEALTH, pet.name, pet.species)
      })
      this._seenVer = ver
      // 等列表渲染完再量分组位置（测量逻辑见 measureGroups）
      this.measureGroups()
    } catch (e) {
      console.error('健康页加载失败', e)
      this.setData({ loading: false, error: true, floatGrp: null })
      // 失败态的头部（无名片）高度和成功态不同，也要重量
      this.measureGroups()
    }
  },

  /* ---------------- 顶部悬浮分组头（替代 CSS sticky） ----------------
   * 背景：页级 position:sticky 在这个基础库/真机上两次实测都不吸顶，
   *       所以改成「JS 量位置 + 监听滚动 + 一条 fixed 单行条」的方案，不依赖 sticky。
   */

  onPageScroll(e) {
    const st = (e && e.scrollTop) || 0
    this._scrollTop = st
    this.updateFloat(st)
  },

  /**
   * 量出每个分组容器在文档里的绝对位置（rect.top + 当前 scrollTop）
   * ⚠️ 必须在 setData 渲染完成后再量：布局是异步的，立刻查会拿到上一帧的位置
   * ⚠️ 切 tab / 下拉刷新 / 数据变化后都要重量；非「全部」tab 直接清掉
   */
  measureGroups() {
    // 头部高度任何时候都要量（无宠物 / 加载失败时列表区也要给固定头让位）；
    // 分组位置只在「全部」tab 有意义
    setTimeout(() => {
      wx.createSelectorQuery()
        .in(this)
        .select('.hp-top').boundingClientRect()
        .selectAll('.grp').boundingClientRect()
        .selectViewport()
        .scrollOffset()
        .exec((res) => {
          const head = (res && res[0]) || {}
          const rects = (res && res[1]) || []
          const scrollTop = (res && res[2] && res[2].scrollTop) || 0
          // 固定头实测高度：列表区 padding-top 和悬浮条 top 都跟它走
          // （宠物名片有/没有 info 行、tab 行高都会变，量出来的才准）
          const headH = Math.round(head.height || 0)
          if (headH && headH !== this.data.headH) {
            this.setData({ headH, grpStickyTop: headH })
          }
          const groups = this.data.allGroups || []
          if (this.data.tab !== 'all' || !rects.length || rects.length !== groups.length) {
            this._grpRects = []
            this.setData({ floatGrp: null })
            return
          }
          this._grpRects = rects.map((r, i) => ({
            title: `${groups[i].name} · ${groups[i].list.length} 次`,
            color: groups[i].color,
            top: r.top + scrollTop,
            bottom: r.bottom + scrollTop
          }))
          this.updateFloat(this._scrollTop || 0)
        })
    }, 60)
  },

  /** 按当前滚动位置决定顶部显示哪个分组标题 */
  updateFloat(st) {
    const list = this._grpRects || []
    if (this.data.tab !== 'all' || !list.length) {
      if (this.data.floatGrp) this.setData({ floatGrp: null })
      return
    }
    const line = st + (this.data.grpStickyTop || 0)
    let cur = null
    for (let i = 0; i < list.length; i++) {
      // 组顶边越过吸顶线就接管显示
      if (line >= list[i].top - 1) cur = list[i]
    }
    // 滚出本组底部 40px 就撤掉：最后一组的卡片往外走时，顶部不再占着标题
    const title = cur && line < cur.bottom - 40 ? cur.title : null
    const prev = this.data.floatGrp
    if (!title) {
      if (prev) this.setData({ floatGrp: null })
      return
    }
    // ⚠️ 只在真的变了才 setData：onPageScroll 每帧都触发，无脑 setData 会白烧渲染
    if (!prev || prev.title !== title) this.setData({ floatGrp: { title, color: cur.color } })
  },

  onRetry() { this.refresh(true) },
  noop() {},
  /**
   * 客服触点 4 埋点：会话已打开
   * ⚠️ 只埋点不做副作用：会话由微信托管，这里拿不到用户说了什么
   */
  onContact(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const ok = String((e && e.detail && e.detail.errMsg) || '').indexOf('contact:ok') !== -1
    require('../../utils/track').track('contact_opened', {
      source: ds.src || 'health_unknown',
      ok: ok ? 1 : 0
    })
  },

  onSwitcher() { this.setData({ showSwitcher: true }) },
  onSwitchClose() { this.setData({ showSwitcher: false }) },
  onSwitchSelect(e) {
    store.setCurrentPet(e.detail.petId)
    require('../../utils/track').track('pet_switched', { petCount: store.state.pets.length })
  },
  onSwitchAdd() { wx.navigateTo({ url: '/pages/pet/edit/edit' }) },

  /** 顶部 chip 切换（全部 / 疫苗 / 驱虫 / 体检） */
  onTab(e) {
    const tab = e.currentTarget.dataset.tab
    // 切回「全部」要重量分组位置（DOM 是刚渲染出来的）
    // ⚠️ shareCount 一起算：分享图标的显隐跟当前 tab 走
    this.setData({ tab, shareCount: this.countOfTab(tab) }, () => this.measureGroups())
  },

  /**
   * 导航栏分享图标（胶囊旁边）：有记录就出图，生成逻辑不变
   * - 疫苗 → 疫苗长图（source: 'vaccine'）
   * - 其余 tab → 健康记录版式（source: 'health'），只装当前 tab 的记录
   */
  onShareTap() {
    const tab = this.data.tab
    if (tab === 'vaccine') { this.onShareVaccine(); return }
    if (tab === 'deworm') { this.shareList(this.data.dewormShown); return }
    if (tab === 'checkup') { this.shareList(this.data.checkups); return }
    this.onShareHealth()
  },

  /**
   * 驱虫 / 体检的分享图：仍走「健康记录」版式（卡片上的圆点/标题都按记录类型取色，
   * 喂进来单一类型的记录也没问题），只是 records 换成当前 tab 的
   */
  shareList(list) {
    if (!(list || []).length) { U.toast('还没有记录'); return }
    this.selectComponent('#sharePop').generate({
      source: 'health',
      pet: this.data.pet,
      records: list,
      weights: this._weights || []
    })
  },

  /** 驱虫二级切换（体内 / 体外） */
  onDewormTab(e) {
    const dewormTab = e.currentTarget.dataset.t
    const dewormShown = this.data.deworms.filter((d) => d.type === dewormTab)
    // 二级切换后条数会变（比如体内 3 条 / 体外 0 条），分享图标的显隐要跟着走
    this.setData({ dewormTab, dewormShown, shareCount: dewormShown.length })
  },

  /**
   * 当前 tab 的记录条数（分享图标显隐用）
   * ⚠️ 传 tab 是为了 tab 切换时算「切过去之后」的条数 —— 那会儿 this.data.tab 可能还没更新
   */
  countOfTab(tab) {
    const t = tab || this.data.tab
    if (t === 'vaccine') return (this.data.vaccines || []).length
    if (t === 'deworm') return (this.data.dewormShown || []).length
    if (t === 'checkup') return (this.data.checkups || []).length
    return (this.data.allList || []).length
  },

  /**
   * 底部悬浮「记一条」：按当前 tab 直接开对应弹层，免去类型选择
   * 全部 / 未知类型 → 默认疫苗；驱虫 tab 需再选体内/体外
   */
  onFabAdd() {
    const tab = this.data.tab
    // 「全部」tab 不对应具体类型：直接弹框并默认选中疫苗
    if (tab === 'all') { this.openHealthSheet('vaccine'); return }
    if (tab === 'deworm') {
      const subs = [
        { key: 'dewormIn', name: '体内驱虫' },
        { key: 'dewormOut', name: '体外驱虫' }
      ]
      wx.showActionSheet({
        itemList: subs.map((s) => s.name),
        success: (res) => {
          const hit = subs[res.tapIndex]
          if (hit) this.openHealthSheet(hit.key)
        }
      })
      return
    }
    this.openHealthSheet(tab === 'checkup' ? 'checkup' : 'vaccine')
  },

  openHealthSheet(hType) {
    const sheet = this.selectComponent('#recordSheet')
    sheet.open({ mode: 'health', hType, isFirst: !(this._health || []).length })
  },

  onAdd(e) {
    const kind = e.currentTarget.dataset.kind
    this.openHealthSheet(kind === 'checkup' ? 'checkup' : kind === 'deworm' ? this.data.dewormTab : 'vaccine')
  },

  onItemTap(e) {
    const { col, id } = e.currentTarget.dataset
    const list = col === 'weights' ? this._weights : this._health
    const record = list.find((r) => r._id === id)
    if (record) this.selectComponent('#recordSheet').open({ mode: 'edit', col, record })
  },

  /** 提醒开关：直接更新记录 */
  async onRemindToggle(e) {
    const id = e.currentTarget.dataset.id
    const on = e.detail.value
    const record = this._health.find((r) => r._id === id)
    if (!record) return
    await db.updateRecord('health', record.petId, id, { remind: on })
    // 关提醒的记录不再需要回捞
    if (!on && record.remindFailed) {
      await db.updateRecord('health', record.petId, id, { remindFailed: false })
    }
    this.refresh()
  },

  /** 补授权（余额 0 的记录，PRD 5.5 验收） */
  onReAuth(e) {
    const tmplId = config.SUBSCRIBE_TEMPLATE_ID
    if (!tmplId) { U.toast('订阅模板未配置'); return }
    const id = e.currentTarget.dataset.id
    const record = this._health.find((r) => r._id === id)
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: async (res) => {
        if (res[tmplId] === 'accept') {
          require('../../utils/track').track('subscribe_requested', { result: 'accept' })
          await db.incrSubBalance(tmplId).catch(() => {})
          if (record) {
            await db.updateRecord('health', record.petId, id, {
              authCount: (record.authCount || 0) + 1,
              remindFailed: false
            })
          }
          U.toast('授权成功')
          this.refresh()
        }
      },
      fail: () => {}
    })
  },

  /** 生成疫苗分享图 */
  onShareVaccine() {
    const list = this._health.filter((h) => h.type === 'vaccine')
    if (!list.length) { U.toast('还没有疫苗记录'); return }
    const sorted = list.slice().sort((a, b) => b.date.localeCompare(a.date))
    this.selectComponent('#sharePop').generate({
      source: 'vaccine',
      pet: this.data.pet,
      records: sorted,
      // 必须带上：统计卡的「当前体重」从这里取，漏传会永远显示「暂无」
      weights: this._weights || []
    })
  },

  /**
   * 生成「健康记录」分享图（全部 tab）
   * 只取三类健康记录（疫苗 + 驱虫 + 体检），不走成长时间线版式，
   * 否则与时间线页的图完全相同
   */
  onShareHealth() {
    if (!(this.data.allList || []).length) { U.toast('还没有健康记录'); return }
    this.selectComponent('#sharePop').generate({
      source: 'health',
      pet: this.data.pet,
      records: this.data.allList,
      weights: this._weights || []
    })
  },

  onTimelineEdit(e) {
    const it = e.detail.item
    this.selectComponent('#recordSheet').open({ mode: 'edit', col: it.col, record: it })
  },
  onSheetSaved() { this.refresh(true) },
  goHome() { wx.switchTab({ url: '/pages/home/home' }) }
})
