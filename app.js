/**
 * 它的时光 · 小程序入口
 * 静默登录（无授权弹窗）+ 云初始化 + 弱网队列重试 + 启动埋点
 */
const config = require('./utils/config')
const store = require('./utils/store')
const track = require('./utils/track')

App({
  globalData: {
    openid: '',
    loginReady: false,
    loginError: false
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '提示',
        content: '当前微信版本过低，无法使用云能力，请升级微信后重试。',
        showCancel: false
      })
      return
    }
    wx.cloud.init({
      env: config.CLOUD_ENV || undefined,
      traceUser: true
    })
    this.loginPromise = this.silentLogin()
    this.appLaunchTs = Date.now()
    this.watchNetwork()

    const isFirst = !wx.getStorageSync('tj_launched')
    track.track('app_launch', { isFirst, scene: wx.getLaunchOptionsSync().scene })
    wx.setStorageSync('tj_launched', true)
  },

  onShow() {
    // 冷启动 / 回前台：重试弱网写队列
    const db = require('./utils/db')
    db.flushSync().then((r) => {
      if (r && r.done) store.emit('dataSynced')
    }).catch(() => {})
    track.flush()
  },

  /** 断网恢复后自动补同步（此前只有「写入 / 回前台 / 手动点」三个时机） */
  watchNetwork() {
    if (!wx.onNetworkStatusChange) return
    wx.onNetworkStatusChange((res) => {
      if (!res || !res.isConnected) return
      const db = require('./utils/db')
      db.flushSync().then((r) => {
        if (r && r.done) store.emit('dataSynced')
      }).catch(() => {})
    })
  },

  onHide() {
    track.track('app_hide', { durationMs: this.appLaunchTs ? Date.now() - this.appLaunchTs : 0 })
    track.flush()
  },

  /**
   * 页面等待登录完成（最多 wait ms）。
   * 超时也放行：页面自行读本地缓存兜底（启动页 ≤ 3s 规则）。
   */
  ready(wait) {
    if (!this.loginPromise) return Promise.resolve()
    return Promise.race([
      this.loginPromise,
      new Promise((resolve) => setTimeout(resolve, wait || 3000))
    ])
  },

  /** 静默登录：云函数上下文直接取 openid，不弹任何授权 */
  async silentLogin() {
    this.globalData.loginError = false
    try {
      const res = await wx.cloud.callFunction({ name: 'login' })
      const openid = res.result && res.result.openid
      if (!openid) throw new Error('login 返回异常')
      this.globalData.openid = openid
      this.globalData.loginReady = true
    } catch (e) {
      console.error('静默登录失败', e)
      this.globalData.loginError = true
      throw e
    }
  }
})
