/**
 * bottom-sheet：底部弹层基座（遮罩 + 滑入/滑出动画 + 顶部拖拽条）
 * 所有弹层（切换宠物 / 录入 / 长图预览）复用
 *
 * 高度纪律（踩坑沉淀）：
 * - maxHeight 属性只是「期望值」（rpx），组件内必须再按屏幕实际高度封顶：
 *   小屏（如 SE 1334rpx 高）上 1400rpx 的面板会顶穿屏幕，✕ 关闭按钮被
 *   状态栏/胶囊挡住，用户无法关闭弹层
 * - 封顶线 = 屏高 - 胶囊底(menuTop+menuHeight) - 30px，面板顶部离胶囊至少 30px
 *
 * 关闭协议（防事件回环：observers 对相同值也会触发，绝不在 observer 里回传事件）：
 * - 用户点遮罩 / ✕：beginClose(true) → 播动画 + triggerEvent('close') 让父级收起
 * - 父级直接置 show=false：observer 里 beginClose(false) 只做 UI 收尾，不回传事件
 * - closing 期间所有重复触发一律忽略
 */
const U = require('../../utils/util')

Component({
  options: {
    multipleSlots: true,
    styleIsolation: 'apply-shared'
  },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    closeable: { type: Boolean, value: true },
    /** 内容区期望最大高度（rpx），组件内会按屏幕高度封顶 */
    maxHeight: { type: Number, value: 1260 }
  },
  data: {
    render: false,
    closing: false,
    maxHpx: '70vh'
  },
  observers: {
    maxHeight() {
      this.calcMaxH()
    },
    show(v) {
      if (v) {
        // 重新打开：取消未完成的收尾
        clearTimeout(this._t)
        this.setData({ render: true, closing: false })
      } else if (this.data.render && !this.data.closing) {
        // 外部已把 show 置 false，只做 UI 收尾，不回传事件（防回环死循环）
        this.beginClose(false)
      }
    }
  },
  lifetimes: {
    attached() {
      this.calcMaxH()
    },
    detached() {
      clearTimeout(this._t)
    }
  },
  methods: {
    noop() {},
    /** 期望高度（rpx→px）与「屏高 - 胶囊底 - 30px」取小，保证面板顶部离胶囊至少 30px */
    calcMaxH() {
      const ui = U.getUI()
      const wanted = ((this.data.maxHeight || 1260) / 750) * ui.windowWidth
      const usable = ui.windowHeight - (ui.menuTop + ui.menuHeight) - 30
      this.setData({ maxHpx: Math.floor(Math.min(wanted, usable)) + 'px' })
    },
    onMask() {
      this.beginClose(true)
    },
    /**
     * @param {boolean} notify 是否通知父级（仅用户主动关闭时 true）
     */
    beginClose(notify) {
      if (!this.data.render || this.data.closing) return
      this.setData({ closing: true })
      clearTimeout(this._t)
      this._t = setTimeout(() => {
        this.setData({ render: false, closing: false })
        this.triggerEvent('closed')
      }, 240)
      if (notify) this.triggerEvent('close')
    }
  }
})
