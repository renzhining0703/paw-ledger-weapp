/**
 * 云函数 subscribe：订阅授权成功后余额 +1（PRD subTickets）
 * 余额是「可推送次数」的估算，实际以微信侧为准
 *
 * ⚠️⚠️ 必须显式写 `_openid`：
 *   云函数（管理端）写入**不会**自动注入 _openid（只有小程序端写入才会）。
 *   漏写的后果：授权记录全变成「无主额度」，remind 云函数按 _openid 永远查不到，
 *   表现为「明明点了很多次授权、页面也显示有余额，推送时每个人 balance 都是 0」。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const tmplId = event.tmplId || 'default'
  if (!OPENID) {
    console.error('[subscribe] 取不到 openid，本次授权无法记账')
    return { err: 'no-openid' }
  }

  const r = await db.collection('subTickets').where({ _openid: OPENID }).limit(1).get()
  if (r.data.length) {
    const doc = r.data[0]
    const balance = (doc.balance || 0) + 1
    await db.collection('subTickets').doc(doc._id).update({
      // update 也带上 _openid：万一旧记录缺这个字段，顺手补齐
      data: { _openid: OPENID, balance, tmplId, updatedAt: db.serverDate() }
    })
    return { balance }
  }
  const add = await db.collection('subTickets').add({
    data: { _openid: OPENID, tmplId, balance: 1, updatedAt: db.serverDate() }
  })
  return { balance: 1, _id: add._id }
}
