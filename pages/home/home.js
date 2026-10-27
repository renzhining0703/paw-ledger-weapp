/**
 * 首页（tab1）：沉浸式暖橙头部 + 名片卡 + 倒计时卡 + 回捞条 + 快捷宫格 + 本月花销卡 + 成长时间线
 * 四态：启动加载（≤3s 兜底）/ 加载失败 / 无宠物建档引导 / 常规
 */
const config = require('../../utils/config')
const store = require('../../utils/store')
const db = require('../../utils/db')
const U = require('../../utils/util')
const TL = require('../../utils/timeline')
const track = require('../../utils/track')
const CS = require('../../utils/cs')

/**
 * 随手记常用胶囊的图标（PRD《随手记自定义常用》附 A：先用现成的，不阻塞上线）
 * 洗澡/换粮 = 设计师已出的线性 png；喂药 = 从设计稿首页胶囊里抠的线性 svg；
 * 其余类型没有线性图标 → 胶囊里回落 emoji（与弹层宫格同款）
 */
const QUICK_DAILY_ICON = {
  bath: '/assets/icons-png/daily-bath.png',
  food2: '/assets/icons-png/daily-food.png',
  med: '/assets/icons-svg/daily-med.svg'
}

Page({
  data: {
    ui: {},
    phase: 'loading', // loading | error | empty | ready
    loadText: '正在准备你的小家…',
    pet: null,
    petView: null,      // 名片卡展示数据
    due: null,          // 倒计时卡两格
    remindFailed: false,
    expense: null,      // 本月花销卡
    timeline: [],       // 最近 4 条
    tlDays: null,       // 在一起天数（到家日起算；无到家日为 null）
    tlCount: 0,         // 时间线记录总数
    pets: [],
    dataError: false,   // 记录区块加载失败（名片卡仍可见）
    showSwitcher: false,
    showDaily: false,   // 随手记备注弹框（daily-sheet 组件，tag 由 quickDaily 预选）
    dailyTag: '',
    /** 随手记常用 3 个胶囊（用户云端配置，未配置过按物种默认；PRD《随手记自定义常用》） */
    quickTags: [],
    /** 全部类型选择弹层（「···」入口，components/daily-picker） */
    showDailyPicker: false,
    // 客服触点（R1）：触点 2（生日 / 到家周年当天）、触点 5（到期提醒落地页）
    csMile: false,
    csRemind: false,
    csFromMile: '',
    csFromRemind: '',
    // 发图文（PRD v2.1 R1 入口 ②：时间线锚点条右侧相机）
    showPost: false,
    postMax: 3,
    postVia: 'timeline',
    postPetName: ''
  },

  onLoad(options) {
    // 订阅消息推送时 page 带了 from=remind（见 cloudfunctions/remind/index.js），
    // 这里据此判定「用户是从到期提醒点进来的」→ 展示触点 5
    this._fromRemind = !!(options && options.from === 'remind')
    const ui = U.getUI()
    // 启动页文案：带上次进入选中的宠物昵称（同步读本地快照，无网络请求）
    const lastPet = db.lastPetName && db.lastPetName()
    this.setData({ ui, loadText: lastPet ? `正在准备${lastPet}的档案…` : '正在准备你的小家…' })
    this._offPet = store.on('petChanged', () => this.refresh())
    this._offSync = store.on('dataSynced', () => this.refresh())
    // 启动页 3 秒兜底：超时直接读本地缓存进首页（PRD 5.14）
    this._launchTimer = setTimeout(() => {
      if (this.data.phase === 'loading') this.boot(true)
    }, 3000)
    this.boot()
  },

  onUnload() {
    this._offPet && this._offPet()
    this._offSync && this._offSync()
    clearTimeout(this._launchTimer)
  },

  onShow() {
    // PRD 第 8 节：查看共享宠物埋点（member 身份进入共享宠物时上报）
    const _pet = store.getCurrentPet()
    if (_pet && _pet.myRole === 'member') {
      require('../../utils/track').track('shared_pet_viewed', { petId: _pet._id, memberCount: _pet.memberCount || 1 })
    }
    if (this.data.phase === 'ready' || this.data.phase === 'empty') {
      // 成员数 / myRole 由云函数维护，store 里的 pets 不会自动更新（别人接受邀请后尤其明显），
      // 先轻量回源一次再刷新；db 层有 60s 缓存，缓存期内是同步命中，不会每次都打网络
      this.syncPetsMeta()
      // 别处有写入（或在别的 tab 记了一笔）后强制回源；
      // ⚠️ 共享宠物一律强制：别人新增的记录不会让本地 dirtyVer 变化，靠缓存会一直看不到
      this.refresh(store.isSharedPet() || store.dirtyVer() !== this._seenVer)
    } else if (this.data.phase === 'error') {
      this.boot()
    }
  },

  /**
   * 轻量回源 pets：只为拿最新的 memberCount / myRole（头部「N 位亲友」的口径来源）
   * 失败静默 —— 名片卡用旧数据照常渲染，不能让一次后台刷新把首页打回错误态
   */
  syncPetsMeta() {
    // ⚠️ 强制回源：memberCount / myRole 是「是否共享」的唯一判据，
    //    走 60s 缓存会拿到旧值 → isSharedPet() 判成非共享 → 读路径不回源 → 看不到别人新记的内容
    db.listPets(true).then((pets) => {
      if (!pets) return
      store.state.pets = pets
      if (this.data.phase !== 'ready') return
      const pet = store.getCurrentPet()
      // 已退出的共享宠物会从列表里消失，此时首页要回到空态，不能继续展示旧档案
      if (!pet) { this.setData({ phase: 'empty' }); return }
      this.setData({ pets, pet, petView: this.buildPetView(pet, this._weights || []) })
    }).catch(() => {})
  },

  onPullDownRefresh() {
    this.refresh(true).finally(() => wx.stopPullDownRefresh())
  },

  /**
   * 客服触点埋点（R1 / R7 埋点口径）
   * source 由各触点的 data-src 传入，云侧 group_map 与之对应做多群分流
   * ⚠️ 只埋点不做副作用：会话由微信托管，这里拿不到用户说了什么，
   *    消息处理统一在云函数 customer
   */
  onContact(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const src = ds.src || ''
    const ok = String((e && e.detail && e.detail.errMsg) || '').indexOf('contact:ok') !== -1
    track.track('contact_opened', { source: src, ok: ok ? 1 : 0 })
  },

  /** 启动流程：等静默登录（最多 3s）→ 拉宠物列表 */
  async boot(soft) {
    try {
      await getApp().ready(3000)
      const pets = await db.listPets()
      store.state.pets = pets
      if (!pets.length) {
        this.setData({ phase: 'empty' })
        return
      }
      const cur = store.getCurrentPet()
      this.setData({ phase: 'ready', pets })
      await this.refresh()
    } catch (e) {
      // 登录/拉取失败：有本地快照则离线进入，否则失败态
      try {
        const pets = await db.listPets()
        store.state.pets = pets
        if (!pets.length) { this.setData({ phase: 'empty' }); return }
        this.setData({ phase: 'ready', pets })
        await this.refresh()
      } catch (e2) {
        this.setData({ phase: soft ? 'ready' : 'error' })
        if (soft) this.refresh().catch(() => {})
      }
    }
  },

  onRetry() {
    this.setData({ phase: 'loading' })
    this.boot()
  },

  /** 先离线使用：读本地缓存进入首页并标记待同步 */
  onOffline() {
    this.setData({ phase: 'ready' })
    this.refresh().catch(() => {})
  },

  /** 刷新页面数据（宠物档案 + 健康 + 体重 + 日常 + 本月/上月花销） */
  async refresh(force) {
    // 记录本次刷新对应的版本（而非结束时的），刷新期间的写入不能被算作已看到
    const ver = store.dirtyVer()
    const pet = store.getCurrentPet()
    if (!pet) {
      this.setData({ phase: 'empty' })
      return
    }
    const today = U.todayStr()
    const ym = U.thisMonthStr()

    // 先渲染名片卡：档案来自 pets 集合本身，即使后续记录拉取失败也能看到基本信息
    this.setData({
      phase: 'ready',
      pets: store.state.pets,
      pet,
      dataError: false,
      petView: this.buildPetView(pet, this._weights || [])
    })

    // 随手记常用胶囊：非阻塞解析（getMySettings 有 memCache，不占首屏关键路径）
    this.resolveQuick()

    try {
      const [health, weights, daily, posts, expenses, prevExpenses] = await Promise.all([
        db.listBy('health', pet._id, { force }),
        db.listBy('weights', pet._id, { force }),
        db.listBy('daily', pet._id, { force }),
        // 图文：⚠️ 必须复用同一个 Promise.all 并发，别单独 await（否则首屏多一个串行耗时）。
        // 单独失败也不拖垮整页 —— 图文拉不到就先只显示数据记录
        db.listPosts(pet._id, { force }).then((list) => {
          // 排障：petId 一并打出来，方便和「成员发布成功」那条日志里的 petId 对比
          console.log('[home] posts 返回', (list || []).length, '条 force=', !!force, 'petId=', pet._id)
          return list
        }).catch((e) => {
          console.error('[home] listPosts 失败', e)
          return []
        }),
        db.listExpensesMonth(pet._id, ym, force),
        db.listExpensesMonth(pet._id, U.monthOffset(ym, -1), force)
      ])
      this._weights = weights
      this._health = health

      // 名片卡（补上体重）
      const petView = this.buildPetView(pet, weights)

      // 倒计时卡
      const due = this.buildDue(TL.nextDue(health, today), today)

      // 回捞条
      const remindFailed = health.some((h) => h.remindFailed && !h.reminded)

      // 本月花销
      const expense = this.buildExpense(expenses, prevExpenses, ym)

      // 时间线预览 4 条 + 「在一起」横幅数据
      const merged = TL.merge(pet, { health, weights, daily, posts })

      // 客服触点 2：生日当天 / 到家周年当天，每人每周最多出现一次
      const mileOn = CS.isTodayMD(pet.birthday) || CS.isAnniversary(pet.adoptDay)
      const csMile = mileOn && (this._mileShown || CS.peek(CS.SOURCES.MILESTONE))
      if (csMile && !this._mileShown) {
        this._mileShown = true
        CS.canShow(CS.SOURCES.MILESTONE)
      }

      this.setData({
        petView,
        due,
        remindFailed,
        expense,
        timeline: merged.slice(0, 4),
        tlDays: this.buildTlDays(pet, today),
        tlCount: merged.length,
        csMile,
        csFromMile: CS.sessionFrom(CS.SOURCES.MILESTONE, pet.name, pet.species),
        csRemind: !!this._fromRemind,
        csFromRemind: CS.sessionFrom(CS.SOURCES.REMIND, pet.name, pet.species)
      })
      this._seenVer = ver
    } catch (e) {
      console.error('首页刷新失败', e)
      // 不再静默：名片卡已经在上面渲染，这里只标记区块加载失败
      this.setData({ dataError: true })
      if (this.data.phase === 'loading') this.setData({ phase: 'error' })
    }
  },

  onDataRetry() {
    this.refresh()
  },

  /** 「在一起」天数：到家日起算的相差天数（设计稿口径 2025-07-13 → 2026-10-22 = 466）；无到家日/未来日期 → null */
  buildTlDays(pet, today) {
    if (!pet || !pet.adoptDay || pet.adoptDay > today) return null
    return Math.max(0, Math.floor((new Date(today).getTime() - new Date(pet.adoptDay).getTime()) / 86400000))
  },

  /** 名片卡展示模型（纯函数，便于单测与复用） */
  buildPetView(pet, weights) {
    const unit = pet.weightUnit || 'kg'
    // 初始体重（档案基准值）：空串/无效值由 initWeightOf 归一成 null（旧档案字段是 initWeight）
    const initWeight = U.initWeightOf(pet)
    const latest = weights && weights.length ? `${U.fmtWeight(weights[0].value)} ${unit}` : ''
    return {
      name: pet.name || '未命名',
      // 真头像；无头像由 pet-avatar 组件按物种 emoji 兜底（不再拼本地物种图）
      avatar: pet.avatar || '',
      gender: pet.gender || '未知',
      isFemale: pet.gender === '母',
      isMale: pet.gender === '公',
      info: [pet.breed, U.formatAge(pet.birthday)].filter(Boolean).join(' · '),
      // 没有称重记录时回落到档案上的初始体重（旧档案为 initWeight）
      weight: latest || (initWeight !== null ? `${U.fmtWeight(initWeight)} ${unit}` : '暂无'),
      birthday: pet.birthday || '—',
      adoptDay: pet.adoptDay || '—',
      // 亲友数 = 成员数 - 创建者。⚠️ 与成员页角标「共享 N/5」的 N（含创建者）口径不同，别混用
      familyCount: Math.max(0, (pet.memberCount || 1) - 1)
    }
  },

  buildDue(next, today) {
    const build = (item, label, cls) => {
      if (!item) return { empty: true, label, cls }
      const days = U.daysBetween(today, item.nextDate)
      // 文案三分：逾期 / 今天 / 未来。「0 天后」是没人说得通的表述（用户实测反馈）
      // 逾期超过 7 天降级为中性「待更新」——一直红着只会让人愧疚然后卸载，不会去补记录
      const longOverdue = days < -7
      let text
      if (longOverdue) text = '待更新'
      // 「逾期」而不是「已逾期」：52rpx 大字下少一个字，否则「逾期 100 天」会溢出格子宽度
      else if (days < 0) text = `逾期 ${-days} 天`
      else if (days === 0) text = '今天到期'
      else text = `${days} 天后`
      return {
        empty: false,
        label,
        cls,
        // 续记要用：更新旧记录的 remind、预填名称与类型
        id: item._id || '',
        type: item.type || '',
        name: item.name || (label === '疫苗' ? '疫苗' : '驱虫'),
        days,
        text,
        subText: longOverdue ? '记录一下最近的这次' : (days < 0 ? '该安排了' : (days === 0 ? '就是今天' : `还有 ${days} 天`)),
        overdue: days < 0 && !longOverdue,
        longOverdue,
        soon: days > 0 && days <= 3,
        // 点击分层：≤3 天（含今天与逾期）直接弹「记录这次接种」，更远的才跳健康页
        urgent: days <= 3,
        date: item.nextDate
      }
    }
    return {
      vaccine: build(next.vaccine, '疫苗', 'vac'),
      deworm: build(next.deworm, '驱虫', 'dew')
    }
  },

  buildExpense(list, prevList, ym) {
    const cats = config.EXPENSE_CATEGORIES.map((c) => ({ ...c, fen: 0 }))
    let total = 0
    list.forEach((e) => {
      total += e.amount || 0
      const c = cats.find((x) => x.key === e.category)
      if (c) c.fen += e.amount || 0
    })
    const prevTotal = prevList.reduce((s, e) => s + (e.amount || 0), 0)
    let momPct = null
    if (prevTotal > 0) momPct = Math.round(((total - prevTotal) / prevTotal) * 100)
    const active = cats.filter((c) => c.fen > 0).sort((a, b) => b.fen - a.fen)
    const pcts = U.percentSplit(active.map((c) => c.fen))
    active.forEach((c, i) => { c.pct = pcts[i] })
    const parts = (ym || U.thisMonthStr()).split('-')
    return {
      total,
      totalText: U.fen2yuanThousand(total),
      monthLabel: `${parts[0]}年${Number(parts[1])}月`,
      momUp: momPct != null && momPct > 0,
      momDown: momPct != null && momPct < 0,
      momText: momPct != null ? `${Math.abs(momPct)}%` : '',
      hasPrev: prevTotal > 0,
      // v1.5 用户反馈：单根细色条贴底 + 图例只有百分比，看不出钱花在哪
      // → 改成「名 + 金额 + 占比」的分类横条，只显示花得最多的前 3 类
      rows: active.slice(0, 3).map((c) => ({
        key: c.key,
        name: c.name,
        color: c.color,
        amountText: U.fen2yuanThousand(c.fen),
        pctText: `${c.pct}%`,
        w: Math.max(c.pct, 4)
      })),
      hasData: total > 0
    }
  },

  /* ---------------- 交互 ---------------- */
  onSwitcher() {
    this.setData({ showSwitcher: true })
  },
  onSwitchClose() {
    this.setData({ showSwitcher: false })
  },
  async onSwitchSelect(e) {
    store.setCurrentPet(e.detail.petId)
    trackPetSwitch()
  },
  onSwitchAdd() {
    if (store.state.pets.length >= config.MAX_PETS) {
      U.toast(`最多添加 ${config.MAX_PETS} 只宠物`)
      return
    }
    wx.navigateTo({ url: '/pages/pet/edit/edit' })
  },

  /** 名片卡 / 统计区点击 → 档案详情页（owner 再从详情页进编辑） */
  onOpenProfile() {
    const pet = this.data.pet
    if (pet) wx.navigateTo({ url: '/pages/pet/profile/profile?petId=' + pet._id })
  },

  /**
   * 头部亲友入口（v1.1d，替代原「编辑档案」位置）
   * 两态（「＋ 邀请亲友」/「N 位亲友 ›」）共用同一个动作：一律进成员列表页。
   * 不在首页直接发起分享 —— 一是无成员时也要让用户先看到成员页的权限说明，
   * 二是避免首页多挂一个离屏 canvas 组件。
   */
  onFamily() {
    const pet = this.data.pet
    if (pet) wx.navigateTo({ url: '/pages/pet/members/members?petId=' + pet._id })
  },

  onAddPet() {
    wx.navigateTo({ url: '/pages/pet/edit/edit' })
  },
  onAddPetEmpty() {
    wx.navigateTo({ url: '/pages/pet/edit/edit' })
  },

  /** 快捷宫格：无宠物时提示先建档（PRD 5.4 ④） */
  onQuick(e) {
    const kind = e.currentTarget.dataset.kind
    if (!this.data.pet) { U.toast('先创建宠物档案'); return }
    const sheet = this.selectComponent('#recordSheet')
    if (kind === 'vaccine') {
      sheet.open({ mode: 'health', hType: 'vaccine' })
    } else if (kind === 'deworm') {
      // 直接指定类型：由弹框按体内驱虫周期预填下次日期，避免打开后再改类型导致提醒失效
      sheet.open({ mode: 'health', hType: 'dewormIn' })
    } else if (kind === 'weight') {
      const w = this._weights || []
      sheet.open({ mode: 'weight', lastWeight: w.length ? w[0].value : null })
    } else if (kind === 'expense') {
      sheet.open({ mode: 'expense' })
    }
  },

  /**
   * 随手记常用胶囊：点击直接开备注弹层（daily-sheet 预选，备注可不填）
   * 常用 3 个来自 users.settings.quickDaily（云端，换手机不丢），未配置过按物种默认
   */
  onDaily(e) {
    if (!this.data.pet) { U.toast('先创建宠物档案，才能随手记'); return }
    this.setData({ showDaily: true, dailyTag: e.currentTarget.dataset.tag || '' })
  },
  /** 「···」→ 全部类型选择弹层（daily-picker，首页与时光页共用同一份配置） */
  onDailyMore() {
    if (!this.data.pet) { U.toast('先创建宠物档案，才能随手记'); return }
    this.setData({ showDailyPicker: true })
  },
  onDailyPickerClose() {
    this.setData({ showDailyPicker: false })
  },
  /** 弹层里点类型 = 关选择层、开备注弹层预选（PRD 3.2：与常用胶囊行为一致） */
  onDailyPickerPick(e) {
    const key = (e && e.detail && e.detail.key) || ''
    this.setData({ showDailyPicker: false, showDaily: true, dailyTag: key })
  },
  /** 编辑常用保存成功 → 胶囊立即换成新的 3 个（验收：保存后回首页立即生效） */
  onDailyConfigured(e) {
    this.applyQuick((e && e.detail && e.detail.tags) || [])
  },
  /** 解析常用 3 个：云端配置优先，校验不过/没配过 → 按当前宠物物种默认 */
  async resolveQuick() {
    try {
      const u = await db.getMySettings()
      const saved = config.normalizeQuickDaily(u && u.settings && u.settings.quickDaily)
      if (saved) { this.applyQuick(saved); return }
    } catch (e) { /* 读失败走默认 */ }
    const pet = this.data.pet || store.getCurrentPet()
    this.applyQuick(config.defaultQuickDaily((pet && pet.species) || ''))
  },
  /** keys → 胶囊渲染数据（bath/food2 用已有线性图标，med 用新抠的线性图标，其余 emoji） */
  applyQuick(keys) {
    const quickTags = (keys || []).map((k) => {
      const t = config.DAILY_PICK.find((x) => x.key === k)
      if (!t) return null
      return { key: t.key, name: t.name, emoji: t.emoji, icon: QUICK_DAILY_ICON[t.key] || '' }
    }).filter(Boolean)
    this.setData({ quickTags })
  },
  onDailyClose() {
    this.setData({ showDaily: false })
  },
  onDailySaved() {
    this.setData({ showDaily: false })
    this.refresh(true)
  },

  onRemindRecover() {
    // 补授权（首页回捞条，PRD 7.2）
    const tmplId = config.SUBSCRIBE_TEMPLATE_ID
    if (!tmplId) { U.toast('订阅模板未配置'); return }
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: async (res) => {
        if (res[tmplId] === 'accept') {
          track.track('subscribe_requested', { result: 'accept' })
          await db.incrSubBalance(tmplId).catch(() => {})
          // 清除 remindFailed 标记
          const pet = this.data.pet
          const health = await db.listBy('health', pet._id, { force: true })
          const failed = health.filter((h) => h.remindFailed)
          for (const h of failed) {
            await db.updateRecord('health', pet._id, h._id, { remindFailed: false })
          }
          U.toast('授权成功，提醒会正常送达')
          this.refresh()
        }
      },
      fail: () => {}
    })
  },

  /**
   * 记账页已从 tabBar 移出（v1.4a：第 3 个 tab 换成「时光」）
   * ⚠️ 它现在是普通页面，只能 navigateTo —— 继续用 switchTab 会直接 fail「点了没反应」
   */
  goLedger() {
    wx.navigateTo({ url: '/pages/ledger/ledger' })
  },
  goHealth() {
    wx.switchTab({ url: '/pages/health/health' })
  },

  /**
   * 倒计时卡点击分层（用户实测反馈：到期当天点进去还得自己找入口，直接流失）
   * - 剩余 > 3 天 / 空态：维持原行为，跳健康页
   * - 剩余 ≤ 3 天、今天、已逾期：直接弹「记录这次接种」续记弹层
   */
  onDueTap(e) {
    const t = e.currentTarget.dataset.t
    const due = this.data.due || {}
    const item = t === 'vaccine' ? due.vaccine : due.deworm
    if (!item || item.empty || !item.urgent) { this.goHealth(); return }
    this.openRenew(item)
  },

  /** 续记弹层：预填类型 / 名称 / 今天；下次日期由弹层按周期算（疫苗 +365 等） */
  openRenew(item) {
    const sheet = this.selectComponent('#recordSheet')
    if (!sheet) return
    sheet.open({
      mode: 'health',
      hType: item.type || 'vaccine',
      name: item.name,
      date: U.todayStr(),
      remind: true,
      // 续记模式：组件据此改标题/副标题，并在保存成功后把旧记录 remind 置 false
      renewFrom: { _id: item.id, type: item.type, name: item.name, nextDate: item.date }
    })
  },
  /**
   * 时光页（原时间线页）已升为 tabBar 第 3 项
   * ⚠️ tabBar 页面只能用 switchTab，navigateTo 会 fail；同时 switchTab 不能带参数
   */
  goTimeline() {
    wx.switchTab({ url: '/pages/timeline/timeline' })
  },

  onTimelineEdit(e) {
    const it = e.detail.item
    // 图文：首页不做全屏预览，点整卡进时间线页（PRD v2.1 R2 首页预览）
    if (it.type === 'moment') {
      wx.switchTab({ url: '/pages/timeline/timeline' })
      return
    }
    const sheet = this.selectComponent('#recordSheet')
    sheet.open({ mode: 'edit', col: it.col, record: it })
  },

  /* ---- 发图文（入口 ②：时间线锚点条右侧相机；要 catchtap 阻断锚点条的 goTimeline） ---- */
  onOpenPost() {
    const pet = store.getCurrentPet()
    if (!pet || !pet._id) { U.toast('先创建宠物档案，才能发图文'); return }
    this.setData({ showPost: true, postMax: 3, postVia: 'timeline', postPetName: pet.name || '' })
  },
  onPostClose() { this.setData({ showPost: false }) },
  onPostSaved() {
    this.setData({ showPost: false })
    U.toast('记好了')
    this.refresh(true)
  },

  onSheetSaved() {
    // force：保存后绝对按最新数据渲染（云端在途由 applyPending 兜底）
    this.refresh(true)
  }
})

function trackPetSwitch() {
  require('../../utils/track').track('pet_switched', { petCount: store.state.pets.length })
}
