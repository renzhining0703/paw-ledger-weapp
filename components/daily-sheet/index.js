/**
 * daily-sheet：记一条日常（7 类型：洗澡/换粮/喂药/不舒服/美容/出门/宠物活动）
 * - 项目列表来自 config.DAILY_PICK（唯一数据源，新增日常项目只改配置）
 * - 支持 tagKey 预选（首页常用胶囊 / daily-picker 选完类型都传 key 直达）；不传则由用户选
 * - 备注非必填；写入 daily 集合后回传 saved，由父级收起弹层并刷新
 */
const config = require('../../utils/config')
const db = require('../../utils/db')
const track = require('../../utils/track')
const U = require('../../utils/util')

Component({
  options: {
    styleIsolation: 'apply-shared'
  },
  properties: {
    show: { type: Boolean, value: false },
    petId: { type: String, value: '' },
    /** 预选项目 key；为空则由用户自己选（默认第一项） */
    tagKey: { type: String, value: '' }
  },
  data: {
    tags: config.DAILY_PICK,
    type: '',
    typeName: '',
    placeholder: '',
    note: '',
    saving: false
  },
  observers: {
    // 只在打开时重置（observer 内禁止回传事件，防事件回环）
    show(v) {
      if (!v) return
      this.pick(this.data.tagKey)
    }
  },
  methods: {
    pick(key) {
      const tags = this.data.tags || []
      if (!tags.length) return
      const hit = tags.find((t) => t.key === key) || tags[0]
      this.setData({ type: hit.key, typeName: hit.name, placeholder: hit.placeholder || '备注可不填', note: '' })
    },
    onType(e) {
      this.pick(e.currentTarget.dataset.k)
    },
    onNote(e) {
      this.setData({ note: e.detail.value })
    },
    /** 用户主动关闭（遮罩/✕）→ 通知父级把 show 置 false */
    onClose() {
      this.triggerEvent('close')
    },
    async onSave() {
      const d = this.data
      if (d.saving) return
      if (!d.petId) { U.toast('先创建宠物档案'); return }
      this.setData({ saving: true })
      try {
        await db.addRecord('daily', d.petId, {
          petId: d.petId,
          tag: d.type,
          tagName: d.typeName,
          date: U.todayStr(),
          note: (d.note || '').trim(),
          createdAtLocal: Date.now()
        })
        track.track('daily_added', { tag: d.type })
        this.triggerEvent('saved', { tag: d.type, tagName: d.typeName })
        U.toast('记好了')
      } catch (e) {
        console.error('日常记录保存失败', e)
        U.toast('保存失败，请重试')
      } finally {
        this.setData({ saving: false })
      }
    }
  }
})
