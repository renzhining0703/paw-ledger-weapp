/**
 * 帮助与反馈（设置页与协议合规 PRD 2.1）
 *
 * 静态 FAQ + 一个「联系客服」。客服按钮与「我的」页同款（open-type="contact"），
 * 不新增云函数 —— 会话本身由微信托管，云侧只在消息推送里处理。
 *
 * ⚠️ FAQ 文案是产品定的（design: 帮助与反馈-feedback），不要顺手改口语风格：
 *    这里是用户在出问题时看的，说得越像人话越好，不要写成说明书。
 */
const CS = require('../../utils/cs')
const store = require('../../utils/store')
const track = require('../../utils/track')

Page({
  data: {
    csFrom: '',
    faqs: [
      {
        q: '数据会丢吗？',
        a: '记录会先存在手机上，联网后自动同步到云端。断网时也能照常记录，恢复网络后自动补传。'
      },
      {
        q: '换手机了怎么办？',
        a: '用同一个微信登录，数据自动同步过来，不用手动迁移。'
      },
      {
        q: '怎么删除记录和宠物？',
        a: '「足迹」里长按可以删除单条记录；宠物档案页可以删除整只宠物，它下面的记录会一起删掉，删了不可恢复。'
      },
      {
        q: '提醒收不到？',
        a: '微信的提醒授权一次只管一次推送，用完需要在「订阅提醒」卡片上补一次授权。'
      },
      {
        q: '照片存在哪里？',
        a: '存在云端存储里，只有你和受邀共享的成员能看到，你可以随时删除。'
      }
    ]
  },

  onLoad() {
    // 客服上下文：把当前宠物带给客服（R6），回答更有针对性
    const pet = store.getCurrentPet()
    this.setData({
      csFrom: CS.sessionFrom(CS.SOURCES.FEEDBACK, pet && pet.name, pet && pet.species)
    })
  },

  onContact(e) {
    // ⚠️ 只在「确实打开了会话」时上报：errMsg 非 ok 的都是失败/取消
    const ok = String((e && e.detail && e.detail.errMsg) || '').indexOf('contact:ok') !== -1
    track.track('contact_opened', { source: CS.SOURCES.FEEDBACK, ok: ok ? 1 : 0 })
  }
})
