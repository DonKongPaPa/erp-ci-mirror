/**
 * 遮掉渠道报错文本里的收件地址。通知记录页按设计不显示收件人，但邮件与短信渠道的
 * 报错常把收件地址带在文本里，显示之前要在这里遮掉。
 *
 * 只按形状遮：邮箱的本地部分换成 `***`、域名保留；以 1 开头的 11 位手机号保留前 3 位
 * 与后 4 位，可带 `+86`、`86`、`0086` 前缀。错误码、编号、时间与 URL 里的数字不动。
 */

// 捕获整段 URL，`split` 才会把它留在分段结果里（没有捕获组时分隔符会被丢掉）。
const URL_PATTERN = /(\b(?:https?:\/\/|www\.)[^\s<>"']+)/giu;

const EMAIL_PATTERN =
  /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)/gu;

// 手机号贴着字母、下划线或横线时不遮：那是编号的一部分，不是独立的号码。
const MOBILE_PATTERN =
  /(?<![\dA-Za-z_-])((?:\+86|0086|86)?)(1\d{2})\d{4}(\d{4})(?![\dA-Za-z_-])/gu;

function maskEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, '***@$1');
}

function maskPlainText(text: string): string {
  return maskEmails(text).replace(MOBILE_PATTERN, '$1$2****$3');
}

/**
 * 把一段渠道报错文本里的邮箱与手机号遮掉，其余原样返回。
 * URL 里的数字串保持原样，所以按 URL 切开，只在非 URL 段遮手机号。
 */
export function redactRecipientAddresses(text: string): string {
  return text
    .split(URL_PATTERN)
    .map((part, index) =>
      index % 2 === 1 ? maskEmails(part) : maskPlainText(part),
    )
    .join('');
}
