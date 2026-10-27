/**
 * daily-picker：全部日常类型选择弹层（PRD《随手记自定义常用》3.2）
 *
 * 两种模式，同一个 sheet：
 * - 普通模式：7 类型宫格（4 列），点类型 = 回传 pick 事件，由父级打开备注弹层（daily-sheet 预选）
 *   ⚠️ 不是「点了直接记」：备注是喂药/不舒服的核心价值（PRD 3.2「与常用胶囊行为一致」，
 *      设计稿底部小字「点一下就记上了」与 PRD 冲突，已与产品确认按 PRD 走，小字文案同步改）
 * - 编辑模式（右上「✎ 编辑常用」）：格子右上出现复选框，选满 3 个其余置灰，
 *   再点提示「最多 3 个，先取消一个」，底部「完成」保存
 *   ⚠️ 不用长按设常用 —— 时间线里长按已是删除语义（PRD 3.2 明确）
 *
 * 配置存储：users.settings.quickDaily（走 db.saveMySettings，云端、换手机不丢）；
 * 从未配置过 → 按「当前宠物 species」套 config.QUICK_DAILY_DEFAULT 默认；
 * ⚠️ 配置过之后不再按物种重置（PRD 2）
 *
 * ⚠️ B5 两处入口共用：首页「···」与时光页 FAB「日常」都开本组件，
 *    配置只有这一份 —— 在首页改了，时光页编辑模式里勾选状态自然一致
 */
const config = require('../../utils/config')
const db = require('../../utils/db')
const store = require('../../utils/store')
const track = require('../../utils/track')
const U = require('../../utils/util')

Component({
  options: {
    styleIsolation: 'apply-shared'
  },

  properties: {
    show: { type: Boolean, value: false },
    /** 副标题「记给 XX」用；时光页/首页都有当前宠物 */
    petName: { type: String, value: '' }
  },

  data: {
    editing: false,
    /** 宫格渲染数据：DAILY_PICK + on（已选）/ dis（编辑模式选满后的置灰） */
    items: [],
    /** 编辑模式当前勾选的 key（普通模式下也维护着，进编辑模式直接用） */
    selKeys: [],
    selCount: 0,
    /** 点第 4 个时的提示条（出现后 1.8s 自动收掉，别常驻 —— 进编辑模式默认就是 3/3） */
    tip: false,
    saving: false
  },

  observers: {
    // 只在打开时初始化（observer 内禁止 triggerEvent，防回环）
    show(v) {
      if (!v) return
      this.setData({ editing: false, tip: false })
      this.loadQuick()
    }
  },

  methods: {
    /** 读云端配置；读不到/没有 → 按物种默认（校验与默认映射收在 config，首页与本组件共用） */
    async loadQuick() {
      let quick = null
      try {
        const u = await db.getMySettings()
        quick = config.normalizeQuickDaily(u && u.settings && u.settings.quickDaily)
      } catch (e) { /* 读失败按未配置处理 */ }
      const pet = store.getCurrentPet()
      this._quick = quick || config.defaultQuickDaily((pet && pet.species) || '')
      this.rebuild(this._quick)
    },

    /** 生成宫格渲染数据 */
    rebuild(sel) {
      const selCount = sel.length
      const items = config.DAILY_PICK.map((t) => ({
        key: t.key,
        name: t.name,
        emoji: t.emoji,
        on: sel.indexOf(t.key) >= 0,
        // 编辑模式才有置灰：已选满 3 且这个没被选 → 点不了（普通模式永远可点）
        dis: this.data.editing && selCount >= 3 && sel.indexOf(t.key) < 0
      }))
      this.setData({ items, selKeys: sel.slice(), selCount })
    },

    /* ---- 普通模式：点类型 = 让父级开备注弹层 ---- */
    onCellTap(e) {
      const key = e.currentTarget.dataset.k
      if (!this.data.editing) {
        this.triggerEvent('pick', { key })
        return
      }
      // 编辑模式：切换勾选
      const sel = this.data.selKeys.slice()
      const i = sel.indexOf(key)
      if (i >= 0) {
        sel.splice(i, 1)
        this.rebuild(sel)
        this.hideTip()
        return
      }
      if (sel.length >= 3) {
        // 提示条：出现 + 1.8s 自动收（进编辑模式默认 3/3，常驻提示会误报）
        this.setData({ tip: true })
        clearTimeout(this._tipT)
        this._tipT = setTimeout(() => this.setData({ tip: false }), 1800)
        return
      }
      sel.push(key)
      this.rebuild(sel)
      this.hideTip()
    },

    hideTip() {
      clearTimeout(this._tipT)
      if (this.data.tip) this.setData({ tip: false })
    },

    /* ---- 编辑模式 ---- */
    onEdit() {
      this.setData({ editing: true, tip: false })
      this.rebuild(this.data.selKeys)
    },
    /** 取消编辑：丢弃改动，回到普通模式（弹层不关，还能接着记） */
    onCancelEdit() {
      this.setData({ editing: false, tip: false })
      this.rebuild(this._quick || this.data.selKeys)
    },
    /** 完成：保存到云端（存 key 数组，固定 3 个） */
    async onFinish() {
      const sel = this.data.selKeys
      if (this.data.saving || sel.length !== 3) return
      this.setData({ saving: true })
      try {
        await db.saveMySettings({ quickDaily: sel })
        track.track('daily_quick_configured', { tags: sel.join(',') })
        this._quick = sel.slice()
        this.setData({ editing: false, tip: false })
        this.rebuild(this._quick)
        // 通知父级（首页要立即更新随手记行的 3 个胶囊）
        this.triggerEvent('configured', { tags: this._quick })
      } catch (e) {
        console.error('[daily-picker] 保存常用失败', e)
        U.toast('保存失败，请重试')
      } finally {
        this.setData({ saving: false })
      }
    },

    /** bottom-sheet 遮罩点击 → 通知父级收起 */
    onClose() {
      this.triggerEvent('close')
    }
  }
})
