/**
 * record-sheet：录入弹层（全局组件，不新增页面栈）
 * 四种模式：health（记健康）/ weight（记体重）/ expense（记花销）/ edit（编辑已有记录）
 * 保存成功不跳转，原地 toast + 触发 saved 事件（PRD 5.9）
 * 健康类保存流程内请求一次性订阅授权（用户 tap 手势上下文内调用）
 */
const config = require('../../utils/config')
const store = require('../../utils/store')
const db = require('../../utils/db')
const U = require('../../utils/util')
const track = require('../../utils/track')

const EMPTY = {
  mode: 'health',
  col: 'health',
  recordId: '',
  petId: '',
  // health
  hType: 'vaccine',
  date: '',
  name: '',
  dose: '',
  nextDate: '',
  remind: true,
  note: '',
  /** 本次花费（元字符串，选填；填了会自动同步记一笔医疗花销） */
  cost: '',
  nameChips: [],
  showNameChips: false,
  // weight
  value: '',
  lastWeight: null,
  // expense
  amount: '',
  category: '',
  cats: config.EXPENSE_CATEGORIES,
  petOptions: [],
  petIndex: -1
}

Component({
  data: Object.assign({}, EMPTY, {
    show: false,
    typeNames: { vaccine: '疫苗', dewormIn: '体内驱虫', dewormOut: '体外驱虫', checkup: '体检' },
    // 表单文案随类型变化（体检/疫苗/驱虫三类口径不同）
    dateLabel: '接种日期',
    nextLabel: '下次接种',
    namePlaceholder: '比如 狂犬疫苗',
    doseOptions: config.DOSE_OPTIONS,
    editing: false,
    today: '',
    saving: false
  }),

  methods: {
    /** 打开入口：pages 通过 selectComponent 调用 */
    open(opts) {
      const o = opts || {}
      // 原始记录留一份在实例上（不入 data）：编辑/删除时用于联动关联花销
      this._record = o.record || null
      const pet = store.getCurrentPet()
      const today = U.todayStr()
      const petOptions = store.state.pets.map((p) => ({ _id: p._id, name: p.name, species: p.species }))

      const data = {
        show: true,
        mode: o.mode || 'health',
        today,
        petOptions,
        weightUnit: (store.getCurrentPet() && store.getCurrentPet().weightUnit) || 'kg',
        nameChips: [],
        showNameChips: false,
        saving: false,
        lastWeight: null,
        isFirst: !!o.isFirst,
        editing: false
      }
      this._openTs = Date.now()

      if (o.mode === 'edit') {
        const r = o.record || {}
        const isHealth = o.col === 'health'
        const isWeight = o.col === 'weights'
        data.editing = true
        data.col = o.col
        data.recordId = r._id
        data.petId = r.petId
        data.date = r.date || today
        data.note = r.note || ''
        data.cost = r.cost > 0 ? U.fen2yuan(r.cost) : ''
        if (isHealth) {
          Object.assign(data, {
            hType: r.type || 'vaccine',
            name: r.name || '',
            dose: r.dose || '',
            nextDate: r.nextDate || '',
            remind: r.remind !== false
          })
        } else if (isWeight) {
          data.value = String(r.value || '')
        } else {
          const cats = config.EXPENSE_CATEGORIES
          data.category = r.category || ''
          data.amount = r.amount != null ? U.fen2yuan(r.amount) : ''
          const idx = petOptions.findIndex((p) => p._id === r.petId)
          data.petIndex = idx
        }
      } else {
        // 新增
        data.editing = false
        data.col = o.mode === 'weight' ? 'weights' : o.mode === 'expense' ? 'expenses' : 'health'
        data.petId = o.petId || (pet && pet._id) || ''
        // 支持入口直接指定健康类型（首页 / 健康页的「驱虫」入口传 hType），
        // 避免打开后再用 setTimeout 改类型——那样会把已预填的下次日期清掉
        data.hType = o.hType || 'vaccine'
        // 支持调用方预填（首页「到期续记」传今天 + 原记录名称）
        data.date = o.date || today
        data.name = o.name || ''
        data.dose = ''
        data.remind = o.remind !== false
        data.note = ''
        data.cost = ''
        data.value = ''
        data.amount = ''
        data.category = ''
        data.petIndex = pet ? petOptions.findIndex((p) => p._id === pet._id) : -1
        // 按类型预填下次日期（疫苗 +365 / 体内 +90 / 体外 +30，仅猫狗等预置物种）
        // 续记同口径：从预填的接种日往后推一个周期
        data.nextDate = o.nextDate || this.calcNext(data.hType, data.date, true) || ''
        // 猫狗预置疫苗常用名 chips
        const sp = config.SPECIES.find((s) => s.key === (pet && pet.species))
        if (o.mode === 'health' && sp && sp.preset) {
          data.nameChips = config.VACCINE_PRESETS
          data.showNameChips = true
        }
        // 体重模式：上次参照（展示口径统一一位小数）
        if (o.mode === 'weight' && o.lastWeight != null) {
          data.lastWeight = U.fmtWeight(o.lastWeight)
        }
      }
      // WXML 分支用：编辑态按 col 还原表单种类
      data.kind = data.editing
        ? (data.col === 'health' ? 'health' : data.col === 'weights' ? 'weight' : 'expense')
        : data.mode
      // 文案随类型走（体检是独立一类健康记录：体检日期 / 下次体检 / 名称占位）
      Object.assign(data, this.typeText(data.hType))

      // 续记模式（首页倒计时卡「到期/临期」点击进来）：换标题与副标题，并在保存后关掉旧记录的提醒
      const renewFrom = o.renewFrom || null
      data.renew = !!renewFrom
      data.renewFromId = renewFrom ? (renewFrom._id || '') : ''
      const RENEW_TITLE = { vaccine: '记录这次接种', dewormIn: '记录这次驱虫', dewormOut: '记录这次驱虫', checkup: '记录这次体检' }
      const RENEW_UNIT = { vaccine: '接种', dewormIn: '驱虫', dewormOut: '驱虫', checkup: '体检' }
      data.renewTitle = RENEW_TITLE[data.hType] || '记录这一次'
      data.renewUnit = RENEW_UNIT[data.hType] || '健康'
      data.renewSubName = (renewFrom && renewFrom.name) || this.data.typeNames[data.hType] || ''
      const pIdx = data.petIndex >= 0 ? data.petIndex : (data.petIndex === 0 ? 0 : -1)
      data.petLabel = data.petOptions[pIdx] ? data.petOptions[pIdx].name : (pet ? pet.name : '')
      this.setData(data)
    },

    close() {
      this.setData({ show: false })
    },

    noop() {},

    /* ---------------- 表单交互 ---------------- */
    onTypeSeg(e) {
      const hType = e.currentTarget.dataset.t
      const patch = { hType, ...this.typeText(hType) }
      patch.nextDate = this.calcNext(hType, this.data.date)
      // 驱虫不显示名称 chips（药品名手填）
      this.setData(patch)
    },

    /** 类型 → 表单文案（体检与疫苗/驱虫口径不同） */
    typeText(hType) {
      if (hType === 'checkup') {
        return { dateLabel: '体检日期', nextLabel: '下次体检', namePlaceholder: '比如 年度体检' }
      }
      if (hType === 'vaccine') {
        return { dateLabel: '接种日期', nextLabel: '下次接种', namePlaceholder: '比如 狂犬疫苗' }
      }
      return { dateLabel: '驱虫日期', nextLabel: '下次驱虫', namePlaceholder: '比如 拜宠清' }
    },
    onName(e) { this.setData({ name: e.detail.value }) },
    onNameChip(e) {
      this.setData({ name: e.currentTarget.dataset.v })
    },
    onDose(e) {
      const v = e.currentTarget.dataset.v
      this.setData({ dose: this.data.dose === v ? '' : v })
    },
    onDate(e) {
      const date = e.detail.value
      this.setData({ date, nextDate: this.calcNext(this.data.hType, date) })
    },
    onNextDate(e) { this.setData({ nextDate: e.detail.value }) },
    onRemind(e) { this.setData({ remind: e.detail.value }) },
    onNote(e) { this.setData({ note: e.detail.value }) },
    onValue(e) { this.setData({ value: e.detail.value }) },
    onAmount(e) { this.setData({ amount: e.detail.value }) },
    onCost(e) { this.setData({ cost: e.detail.value }) },
    onCat(e) { this.setData({ category: e.currentTarget.dataset.k }) },
    onPetPick(e) { this.setData({ petIndex: Number(e.detail.value) }) },

    /**
     * 下次日期自动预填：体检 +365（所有物种）/ 疫苗 +365 / 体内 +90 / 体外 +30（仅猫狗等预置物种）
     * @param {boolean} force 忽略编辑态（open 时用：此时 this.data 还是上一条记录的残留）
     */
    calcNext(hType, date, force) {
      if (!date || (this.data.editing && !force)) return this.data.nextDate
      // 体检一年一两次，对任何物种都预填一年后，不需要物种预置
      if (hType === 'checkup') return U.offsetDate(date, config.CHECKUP_CYCLE_DAYS)
      const pet = store.getCurrentPet()
      const sp = config.SPECIES.find((s) => s.key === (pet && pet.species))
      if (!sp || !sp.preset) return ''
      const days = hType === 'vaccine'
        ? config.VACCINE_CYCLE_DAYS
        : hType === 'dewormIn' ? config.DEWORM_IN_CYCLE_DAYS : config.DEWORM_OUT_CYCLE_DAYS
      return U.offsetDate(date, days)
    },

    /* ---------------- 校验 ---------------- */
    validate() {
      const d = this.data
      if (d.mode === 'weight' || (d.editing && d.col === 'weights')) {
        const v = parseFloat(d.value)
        if (!d.value || isNaN(v) || v <= 0) return '请填写体重'
        return ''
      }
      if (d.mode === 'expense' || (d.editing && d.col === 'expenses')) {
        const fen = U.yuan2fen(d.amount)
        if (fen == null || fen <= 0) return '请填写金额'
        if (fen > 99999 * 100) return '单笔上限 99999 元'
        if (!d.category) return '请选择分类'
        if (d.petIndex < 0) return '请选择归属宠物'
        return ''
      }
      // health
      if (!d.date) return '请选择日期'
      // 花费选填：填了就必须是合法金额（空串视为不填）
      if (d.cost && U.yuan2fen(d.cost) == null) return '花费金额填写有误'
      if (U.yuan2fen(d.cost) > 99999 * 100) return '单笔上限 99999 元'
      return ''
    },

    /* ---------------- 保存 ---------------- */
    onSave() {
      if (this.data.saving) return
      const err = this.validate()
      if (err) { U.toast(err); return }

      const d = this.data
      // 健康类新增且开提醒：先在 tap 手势上下文内请求一次性订阅授权（PRD 7.2 纪律 1）
      if (d.mode === 'health' && !d.editing && d.remind && config.SUBSCRIBE_TEMPLATE_ID) {
        this.requestAuthThenSave()
        return
      }
      this.doSave()
    },

    requestAuthThenSave() {
      const tmplId = config.SUBSCRIBE_TEMPLATE_ID
      const finish = (accepted) => {
        this.doSave(accepted)
      }
      wx.requestSubscribeMessage({
        tmplIds: [tmplId],
        success: (res) => {
          const accepted = res[tmplId] === 'accept'
          track.track('subscribe_requested', { result: accepted ? 'accept' : 'reject' })
          if (accepted) db.incrSubBalance(tmplId).catch(() => {})
          finish(accepted)
        },
        fail: (e) => {
          // 用户勾选「总是保持以上选择」后系统静默忽略，走 fail；不重复弹窗、不报错
          track.track('subscribe_requested', { result: e && e.errCode === 20004 ? 'banned' : 'reject' })
          finish(false)
        }
      })
    },

    async doSave(accepted) {
      const d = this.data
      const kind = d.editing
        ? (d.col === 'health' ? 'health' : d.col === 'weights' ? 'weight' : 'expense')
        : d.mode
      this.setData({ saving: true })
      const startTs = this._openTs || Date.now()

      try {
        if (kind === 'health') {
          const costFen = U.yuan2fen(d.cost) || 0
          const payload = {
            type: d.hType,
            name: (d.name || '').trim(),
            dose: d.dose || '',
            date: d.date,
            nextDate: d.nextDate || '',
            remind: !!d.remind,
            note: (d.note || '').trim(),
            cost: costFen
          }
          if (d.editing) {
            await db.updateRecord('health', d.petId, d.recordId, payload)
            // 花费变了要同步关联花销：改金额 / 补记 / 清空
            await this.syncExpense(this._record || {}, payload, costFen, d.petId)
          } else {
            payload.reminded = false
            payload.remindFailed = false
            payload.authCount = accepted ? 1 : 0
            const rec = await db.addRecord('health', d.petId, payload)
            track.track('record_added', { type: d.hType, isFirstRecord: !!d.isFirst, durationMs: Date.now() - startTs })
            // 续记：旧记录对应的针已经打了，必须关掉它的提醒，
            // 否则它带着过期的 nextDate 留在库里，改天补跑/换扫描口径时还会再推一次错的提醒。
            // remindFailed 一并清掉：否则首页「N 条提醒失败」回捞条会被这条已结案的记录占着。
            // 失败不阻断主流程（新记录已落库），但要打日志便于排查
            if (d.renew && d.renewFromId) {
              await db.updateRecord('health', d.petId, d.renewFromId, { remind: false, remindFailed: false })
                .catch((e) => { console.error('[record-sheet] 续记后关闭旧记录提醒失败', e) })
            }
            // 填了花费 → 同步记一笔医疗花销（花销侧记 sourceId 指回这条健康记录）。
            // 这里刻意不等云端返回真 _id：保存要立刻反馈，id 落地由 db.fixRefs 自动修正。
            // 花销写入失败不影响健康记录本身（重试一次，再失败打日志，队列重试兜底）
            if (costFen > 0) {
              try {
                await this.linkExpense(payload, costFen, d.petId, rec._id)
              } catch (e2) {
                console.warn('关联花销写入失败，重试一次', e2)
                await this.linkExpense(payload, costFen, d.petId, rec._id)
              }
            }
          }
        } else if (kind === 'weight') {
          const value = Math.round(parseFloat(d.value) * 10) / 10
          const payload = { date: d.date, value, note: (d.note || '').trim() }
          if (d.editing) {
            await db.updateRecord('weights', d.petId, d.recordId, payload)
          } else {
            await db.addRecord('weights', d.petId, payload)
            track.track('record_added', { type: 'weight', isFirstRecord: !!d.isFirst, durationMs: Date.now() - startTs })
          }
        } else {
          // expense
          const pet = d.petOptions[d.petIndex]
          const payload = {
            amount: U.yuan2fen(d.amount),
            category: d.category,
            date: d.date || d.today,
            petId: pet._id,
            note: (d.note || '').trim()
          }
          if (d.editing) {
            await db.updateRecord('expenses', `${d.petId}_${(payload.date || '').slice(0, 7)}`, d.recordId, payload)
          } else {
            await db.addRecord('expenses', `${payload.petId}_${(payload.date || '').slice(0, 7)}`, payload)
            track.track('expense_added', { category: d.category, amountRange: track.amountRange(parseFloat(d.amount)) })
          }
        }

        this.setData({ show: false, saving: false })
        U.toast('记好了')
        this.triggerEvent('saved', { mode: d.mode, col: d.col, editing: d.editing })
        // PRD 第 8 节：共享宠物下记录埋点（区分 owner/member）
        const _pet = (store.state.pets || []).find((p) => p._id === d.petId)
        if (_pet && (_pet.memberCount || 1) > 1) {
          track.track('shared_record_added', { petId: d.petId, type: d.col, isOwner: _pet.myRole === 'owner' })
        }
      } catch (e) {
        console.error('保存失败', e)
        this.setData({ saving: false })
        U.toast('保存失败，已存本地待同步')
        this.triggerEvent('saved', { mode: d.mode, col: d.col, editing: d.editing })
      }
    },

    /**
     * 健康记录的花费 → 记一笔医疗花销（健康页 / 时间线 / 记账页 / 本月花销 同源）
     * @returns {object} 新建的花销记录（本地乐观对象，_id 可能是 local_ 前缀）
     */
    async linkExpense(payload, costFen, petId, sourceId) {
      const note = [this.typeName(payload.type), payload.name].filter(Boolean).join(' · ')
      const ym = (payload.date || '').slice(0, 7)
      const rec = await db.addRecord('expenses', `${petId}_${ym}`, {
        amount: costFen,
        category: 'medical',
        date: payload.date,
        petId,
        note,
        sourceType: 'health',
        sourceId: sourceId || ''
      })
      track.track('expense_added', {
        category: 'medical',
        amountRange: track.amountRange(costFen / 100),
        source: 'health'
      })
      return rec
    },

    typeName(type) {
      return this.data.typeNames[type] || '健康记录'
    },

    /** 找出这条健康记录关联的那笔花销（花销侧存 sourceId 指回健康记录） */
    async findLinkedExpense(healthId, petId) {
      if (!healthId || !petId) return null
      const list = await db.listBy('expenses', petId).catch(() => [])
      return list.find((e) => e.sourceType === 'health' && e.sourceId === healthId) || null
    },

    /**
     * 编辑健康记录时同步关联花销：
     * 填了金额 → 有关联花销则改金额，没有则补记一条；清空金额 → 删掉关联花销
     */
    async syncExpense(record, payload, costFen, petId) {
      const ym = (payload.date || '').slice(0, 7)
      const key = `${petId}_${ym}`
      const healthId = record._id || this.data.recordId
      const linked = await this.findLinkedExpense(healthId, petId)
      if (costFen > 0) {
        const patch = {
          amount: costFen,
          date: payload.date,
          petId,
          note: [this.typeName(payload.type), payload.name].filter(Boolean).join(' · ')
        }
        if (linked) await db.updateRecord('expenses', key, linked._id, patch)
        else await this.linkExpense(payload, costFen, petId, healthId)
      } else if (linked) {
        await db.removeRecord('expenses', key, linked._id)
      }
    },

    onDelete() {
      const d = this.data
      const rec = this._record || {}
      // 删除健康记录 → 连带删掉它产生的花销；删除花销 → 把健康记录的金额清零
      const isHealth = d.col === 'health'
      const linked = isHealth ? null : rec
      // PRD 5.4：共享宠物下删记录，文案须写明「其他 N 位成员也将看不到」
      const pet = (store.state.pets || []).find((p) => p._id === d.petId)
      const memberCount = (pet && pet.memberCount) || 1
      const sharedSuffix = memberCount > 1 ? `，其他 ${memberCount - 1} 位成员也将看不到这条记录` : ''
      const tip = (isHealth
        ? '这条记录将连同它产生的那笔花销一起删除，无法恢复'
        : (rec.sourceType === 'health'
          ? '这笔来自健康记录，删除后那笔记录上的金额会一并清空'
          : '这条记录将被删除，无法恢复')) + sharedSuffix
      U.confirmDelete(tip, async () => {
        if (isHealth) {
          const exp = await this.findLinkedExpense(rec._id, d.petId)
          await db.removeRecord(d.col, d.petId, d.recordId)
          if (exp) await db.removeRecord('expenses', `${d.petId}_${(rec.date || '').slice(0, 7)}`, exp._id)
        } else {
          await db.removeRecord(d.col, d.petId, d.recordId)
          if (linked && linked.sourceType === 'health' && linked.sourceId) {
            await db.updateRecord('health', d.petId, linked.sourceId, { cost: 0 })
          }
        }
        this.setData({ show: false })
        U.toast('已删除')
        this.triggerEvent('saved', { mode: d.mode, col: d.col, deleted: true })
      })
    },

    onDateEdit(e) {
      // 编辑态也允许改日期，但不自动重算下次日期（保留用户手填值）
      this.setData({ date: e.detail.value })
    }
  }
})
