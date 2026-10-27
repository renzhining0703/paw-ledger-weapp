/**
 * 关于页（静态页）
 * 合规要求：不出现任何联系方式、外链、二维码（PRD 红线 3）
 */
const config = require('../../utils/config')

Page({
  data: {
    version: config.VERSION
  }
})
