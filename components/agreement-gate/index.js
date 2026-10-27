/**
 * agreement-gate：首次启动协议门禁
 *
 * 做两件事：
 * ① 没同意过 → 弹「欢迎使用」对话框（正文 3 条要点 + 可点《用户协议》《隐私政策》）
 * ② 点「不同意」→ 不裸退，先显示全屏占位层，再**试一次** exitMiniProgram
 *
 * ⚠️ 为什么不用 wx.showModal（PRD 原案）：showModal 只能纯文本，
 *    协议名不可点 → 用户在同意前没有任何途径读到协议全文，而点「不同意」就退出了。
 *    这是「未提供隐私政策」的典型认定，提审有被挑风险。
 * ⚠️ 为什么不裸调 exitMiniProgram：该 API 只在「小程序跳小程序 / 扫码」等部分场景可用，
 *    从聊天/发现进入经常直接 fail。失败后若只剩 toast，用户被弹窗挡着又干不了任何事，只能杀进程。
 *    所以占位层必须**先**摆好，退出成功与否都不影响用户有路可走。
 *
 * 用在哪些页面：pages/home（tab1 主入口）+ pages/invite/accept（分享邀请会作为独立落地页进来）
 * 只有这两个页面可能成为冷启动的第一屏，其它页面都由它们跳转而来。
 */
const config = require('../../utils/config')
const track = require('../../utils/track')

Component({
  options: {
    styleIsolation: 'apply-shared'
  },

  data: {
    show: false,
    blocked: false,
    /**
     * 三条隐私要点（设计稿 v1.4b）
     * ⚠️ 拆成 pre / b / suf 三段是为了「一行里只有关键词加粗」——
     *    WXML 拼不出富文本，只能靠多段 text 拼，加粗段可缺省
     */
    points: [
      { pre: '只收集微信登录标识用于数据同步，', b: '不需要手机号' },
      { pre: '记录的内容仅自己和', b: '受邀共享的成员', suf: '可见' },
      { pre: '你可以随时删除全部数据，说删就删' }
    ],
    linkUser: { text: '《用户协议》', url: '/pages/agreement/agreement?type=user' },
    linkPrivacy: { text: '《隐私政策》', url: '/pages/agreement/agreement?type=privacy' }
  },

  lifetimes: {
    attached() {
      this.check()
    }
  },

  methods: {
    check() {
      let agreed = ''
      try {
        agreed = wx.getStorageSync(config.AGREEMENT_KEY) || ''
      } catch (e) {
        agreed = ''
      }
      if (agreed) {
        // 同意过：什么都不做（不弹、也不占位）
        this.triggerEvent('agreed', { cached: true })
        return
      }
      // 信标：确认新 bundle 在跑（真机热重载对组件 js 不可靠）
      console.log('[agreement-gate] 未同意，弹窗 key=', config.AGREEMENT_KEY)
      this.setData({ show: true })
    },

    onAgree() {
      try {
        wx.setStorageSync(config.AGREEMENT_KEY, '1')
      } catch (e) {
        // 写不进去（存储满）不该拦住用户：本次会话内不再弹即可
        console.warn('[agreement-gate] 写 storage 失败', e)
      }
      this.setData({ show: false, blocked: false })
      track.track('agreement_agreed', { v: config.AGREEMENT_VERSION })
      this.triggerEvent('agreed', { cached: false })
    },

    onReject() {
      // 顺序很重要：先把占位层摆好，再尝试退出
      this.setData({ show: false, blocked: true })
      if (typeof wx.exitMiniProgram !== 'function') {
        console.log('[agreement-gate] 基础库过低，无 exitMiniProgram，停在占位层')
        return
      }
      wx.exitMiniProgram({
        fail: () => {
          // 这是常见结果（非「跳小程序」场景），不是错误，不必打扰用户
          console.log('[agreement-gate] exitMiniProgram fail，停在占位层')
        }
      })
    },

    onReopen() {
      this.setData({ blocked: false, show: true })
    },

    /**
     * 点协议名 → 打开协议页，**不关闭本弹层**
     * ⚠️ 关了就违背「同意前可读全文」：用户读完返回还得再点一次才能弹回来，甚至可能以为已同意
     */
    onLink(e) {
      const url = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.url) || ''
      if (!url) return
      wx.navigateTo({ url })
    },

    /** catchtouchmove 用：空实现，只为阻断滑动穿透到背后的页面 */
    noop() {}
  }
})
