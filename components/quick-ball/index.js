/**
 * quick-ball：悬浮快记球（首页 / 时间线页 / 健康页常驻）
 * 收起：56px 主色圆球；展开：3×3 日常标签宫格，点标签即写入记录（零表单）
 * 日常快记不是打卡：无连续天数、无提醒、不进健康 tab（PRD 模块 8）
 */
const config = require('../../utils/config')
const store = require('../../utils/store')
const db = require('../../utils/db')
const U = require('../../utils/util')
const track = require('../../utils/track')

Component({
  properties: {
    /** 底部偏移（rpx），默认距底 200，页面有 tab 时由页面调 */
    bottom: { type: Number, value: 150 }
  },
  data: {
    expanded: false,
    tags: config.DAILY_TAGS
  },
  lifetimes: {
    detached() {
      this._off && this._off()
    }
  },
  methods: {
    toggle() {
      const pet = store.getCurrentPet()
      if (!pet) {
        U.toast('先创建宠物档案，才能随手记')
        this.triggerEvent('nopet')
        return
      }
      this.setData({ expanded: !this.data.expanded })
    },
    onMask() {
      this.setData({ expanded: false })
    },
    noop() {},
    onTag(e) {
      const { key, name } = e.currentTarget.dataset
      const pet = store.getCurrentPet()
      if (!pet) {
        U.toast('先创建宠物档案，才能随手记')
        this.triggerEvent('nopet')
        return
      }
      db.addRecord('daily', pet._id, {
        petId: pet._id,
        tag: key,
        tagName: name,
        date: U.todayStr(),
        note: '',
        createdAtLocal: Date.now()
      }).then(() => {
        track.track('daily_added', { tag: key })
        U.toast('记好了')
        this.setData({ expanded: false })
        this.triggerEvent('recorded', { tag: key })
      })
    }
  }
})
