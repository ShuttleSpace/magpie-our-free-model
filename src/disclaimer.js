/**
 * The disclaimer copy both surfaces show: the plugin's settings page and the
 * standalone/desktop console.
 *
 * The magpie branch offers the channels that upstream main excludes: WorkBuddy
 * (both builds) and Huawei Cloud MaaS / CodeArts. They are reachable through
 * Magpie's channel management, so the copy states what they are and where the
 * responsibility sits instead of claiming the build does not carry them.
 *
 * The copy is data, not markup: each surface renders it in its own idiom, so
 * there is exactly one place to change what the product says. Bump the version
 * when the copy changes so users re-acknowledge it.
 */

export const DISCLAIMER_VERSION = 3

/** Channels upstream excludes but this branch offers, named for the reader. */
export const OFFERED_RESTRICTED_CHANNELS = Object.freeze([
  'WorkBuddy 国内版（workbuddy，亦称 CodeBuddy）',
  'WorkBuddy 国际版（workbuddy-ai）',
  '华为云 Huawei Cloud MaaS（huaweicloud，含 Token Plan）',
  '华为云 CodeArts（codearts，码道）',
])

export const DISCLAIMER = Object.freeze({
  version: DISCLAIMER_VERSION,
  title: '使用须知与免责声明',
  subtitle: '关于第三方渠道，以及你需要知道的责任边界',
  intro: '本插件是一个个人学习与技术研究项目，用于学习模型网关、协议适配与本地路由的实现方式，按「现状」提供，不构成任何商业服务或产品承诺。',
  sections: Object.freeze([
    {
      id: 'channels',
      heading: '这些渠道由第三方提供',
      body: '本 magpie 分支额外提供 WorkBuddy 国内版（workbuddy，亦称 CodeBuddy）、WorkBuddy 国际版（workbuddy-ai）、华为云 Huawei Cloud MaaS（huaweicloud，含 Token Plan）与华为云 CodeArts（codearts，码道）。它们经 Magpie 的渠道管理安装与登录，由对应厂商及社区插件提供服务；本插件不托管这些服务，也不对其可用性、额度或合规性作承诺。',
    },
    {
      id: 'responsibility',
      heading: '使用第三方渠道由你自行负责',
      body: '你若在本插件中使用上述渠道或其他第三方服务，包括自行配置地址、导入凭据、安装第三方软件或登录账号，均属于你的个人行为，与本项目作者及团队无关。我们不参与、不背书、不提供支持，也不对其可用性、合规性或任何后果承担任何责任。',
    },
    {
      id: 'accounts',
      heading: '账号与凭据由你自己负责',
      body: '本插件只在你本机保存你主动导入的凭据，不会上传到任何服务器。请确保你使用这些账号的方式符合对应服务商的条款与所在地法律；由此产生的封禁、扣费、数据风险或其他损失，由使用者自行承担。',
    },
    {
      id: 'no-warranty',
      heading: '不提供任何担保',
      body: '本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。',
    },
    {
      id: 'lawful',
      heading: '请合法合规使用',
      body: '本项目仅用于个人学习与技术研究。请勿将其用于违反服务商条款、规避授权限制、批量滥用额度、转售额度或其他违法用途。尤其是通过社区插件接入上述桌面渠道时，请自行确认其签名与调用方式是否被服务商允许；因使用方式不当引发的争议、索赔或法律责任，均由使用者自行承担。',
    },
  ]),
  accept: '我已阅读并了解',
  reopen: '查看免责声明',
})

/** Whether a stored acknowledgement matches the current copy version. */
export function disclaimerAcknowledged(settings) {
  return Number(settings?.disclaimerAck) === DISCLAIMER_VERSION
}
