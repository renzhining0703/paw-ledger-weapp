/**
 * ui-dialog：居中对话框（遮罩 + 大圆角白卡 + 分割线按钮）
 *
 * 为什么不用 wx.showModal：
 * ① 系统 modal 圆角/间距/字号固定，与设计稿（270pt 宽、16pt 圆角、橙色主按钮）对不上；
 * ② 协议弹窗正文里要放「《用户协议》《隐私政策》」两个可点链接，showModal 只能纯文本 ——
 *    那会导致「同意前无法阅读协议」，是合规硬伤。
 *
 * 关闭协议（照抄 bottom-sheet 的防回环写法，已踩过）：
 * - 用户点按钮/遮罩：beginClose(true) 播动画 + triggerEvent 让父级收起
 * - 父级直接置 show=false：observer 里 beginClose(false) 只做 UI 收尾，不回传事件
 *   （observers 对相同值也会触发，observer 里 triggerEvent = 死循环）
 * - closing 期间重复触发一律忽略
 *
 * 用法：
 *   <ui-dialog show="{{x}}" title="清理缓存？" content="…" cancel-text="取消" confirm-text="清理"
 *              bind:confirm="onX" bind:cancel="onXCancel" />
 *   需要自定义正文（带链接/换行/富结构）时不传 content，直接用默认 slot
 */
Component({
  options: {
    multipleSlots: true,
    styleIsolation: 'apply-shared'
  },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    /** 纯文本正文；传了就不渲染 slot。支持 \n 换行（wxss 里 white-space: pre-line） */
    content: { type: String, value: '' },
    /**
     * 正文下方的一行链接：[{ text:'《用户协议》', url:'/pages/agreement/agreement?type=user' }]
     * ⚠️ 为什么做成属性而不是 slot：slot 内容的样式由「使用方页面」的 wxss 决定，
     *    组件 wxss 管不到 —— 同一套链接样式得在每个用到弹窗的页面各写一遍（已踩）。
     *    这里由组件统一渲染 + 统一 wx.navigateTo，调用方零成本。
     */
    links: { type: Array, value: [] },
    /** 空字符串 = 单按钮模式（拦截提示这种「我知道了」） */
    cancelText: { type: String, value: '取消' },
    /**
     * 强制单按钮。语义比「cancelText 传空字符串」明确得多 ——
     * 空串在 wxml 里是否真的覆盖默认值属于实现细节，不该拿来做开关（默认值被吃掉就会多出一个取消键）
     */
    single: { type: Boolean, value: false },
    confirmText: { type: String, value: '确定' },
    /** 主按钮用警示红（删除类操作） */
    danger: { type: Boolean, value: false },
    /** 点遮罩是否关闭。协议弹窗/清理确认必须 false（误触一下就关掉太危险） */
    maskClosable: { type: Boolean, value: false }
  },
  data: {
    render: false,
    closing: false
  },
  observers: {
    show(v) {
      if (v) {
        clearTimeout(this._t)
        this.setData({ render: true, closing: false })
      } else if (this.data.render && !this.data.closing) {
        // 父级已置 false：只做 UI 收尾，不回传事件
        this.beginClose(false)
      }
    }
  },
  lifetimes: {
    detached() {
      clearTimeout(this._t)
    }
  },
  methods: {
    noop() {},

    /**
     * @param {string} eventName 收尾后要回传的事件名（'' = 不回传，用于父级自己置 false 的收尾）
     * ⚠️ 一次交互只回传一个事件：之前写成「先 triggerEvent('close') 再 triggerEvent('confirm')」，
     *    父级两个都监听时同一次点击会跑两遍
     */
    beginClose(eventName) {
      if (this.data.closing) return
      this.setData({ closing: true })
      clearTimeout(this._t)
      this._t = setTimeout(() => {
        this.setData({ render: false, closing: false })
        if (eventName) this.triggerEvent(eventName)
      }, 180)
    },

    onMaskTap() {
      if (!this.data.maskClosable) return
      this.beginClose('close')
    },

    onCancel() {
      this.beginClose('cancel')
    },

    onConfirm() {
      // 先播关闭动画再通知：父级在 confirm 里 setData show=false 时，observer 会看到 closing 已置位而跳过
      this.beginClose('confirm')
    },

    /** 正文下方链接：跳协议页（不关闭弹层，返回后弹层还在，用户能接着点同意） */
    onLink(e) {
      const url = e.currentTarget.dataset.url
      if (!url) return
      wx.navigateTo({ url })
    }
  }
})
