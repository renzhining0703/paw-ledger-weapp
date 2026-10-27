const agreements = require('../../utils/agreements')

/**
 * 用户协议 / 隐私政策（二级页，type=user|privacy）
 *
 * ⚠️ 不能用 web-view：个人主体小程序没有该组件权限（PRD 7.1）
 * ⚠️ 不用 rich-text：见 utils/agreements.js 顶部注释（样式要逐节点内联，改版式动几百处）
 */
Page({
  data: {
    doc: null
  },

  onLoad(q) {
    const type = (q && q.type) || 'user'
    const doc = agreements.get(type)
    if (doc) wx.setNavigationBarTitle({ title: doc.navTitle })
    this.setData({ doc })
    // 信标：确认新 bundle 在跑（真机热重载对页面 js 不可靠，日志缺失就是旧代码）
    console.log('[agreement] type=', type, 'blocks=', doc ? doc.blocks.length : 0)
  },

  goBack() {
    // 从协议弹层点进来时，返回栈里一定有页面；单独扫小程序码进来时兜底回首页
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/home/home' })
    })
  }
})
