/**
 * 遮掉一段文本里的收件地址。两处共用这一份实现：
 *
 * - 通知记录页显示渠道报错之前（R-034 的「不显示收件人」）——`client/lib/redact-recipients.ts`
 *   只是这里的转出口；
 * - R-002 的代填把客户正文发给模型之前。两边要求一样：号码的常见写法都不许原样留下。
 *
 * 只按形状遮：邮箱的本地部分换成 `***`、域名保留；手机号与座机保留前 3 位（座机保留
 * 区号）与后 4 位，中间打星。手机号可以是连续 11 位，也可以带空格、短横、点号，可带
 * `+86`、`86`、`0086` 前缀；全角数字先折成半角再判。座机是 `0` 开头的 3～4 位区号加
 * 7～8 位号码，区号后可有分隔符。
 *
 * 错误码、编号、时间与 URL 里的数字不动：URL 整段跳过；贴着字母、下划线或短横的
 * 数字串按编号对待。
 */

// 捕获整段 URL，`split` 才会把它留在分段结果里（没有捕获组时分隔符会被丢掉）。
const URL_PATTERN = /(\b(?:https?:\/\/|www\.)[^\s<>"']+)/giu;

const EMAIL_PATTERN =
  /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)/gu;

// 手机号贴着字母、下划线或横线时不遮：那是编号的一部分，不是独立的号码。
// 段间允许空格、短横、点号；前缀单独一段，允许与前缀之间有分隔符。
const MOBILE_PATTERN =
  /(?<![\dA-Za-z_-])((?:\+?86|0086)?[\s-]*)(1[3-9]\d)[\s.-]*\d{4}[\s.-]*(\d{4})(?![\dA-Za-z_-])/gu;

// 座机：0 开头的 3～4 位区号 + 7～8 位号码，区号后可有分隔符。
const LANDLINE_PATTERN =
  /(?<![\dA-Za-z_-])(0\d{2,3})[\s.-]?(\d{3,4})(\d{4})(?![\dA-Za-z_-])/gu;

const FULL_WIDTH: Readonly<Record<string, string>> = {
  '＋': '+',
  '－': '-',
  '．': '.',
  '\u3000': ' ',
};

function toHalfWidth(text: string): string {
  return text.replace(
    /[０-９＋－．\u3000]/gu,
    (character) =>
      FULL_WIDTH[character] ??
      String.fromCharCode(character.charCodeAt(0) - 0xfee0),
  );
}

function maskEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, '***@$1');
}

function maskPhones(text: string): string {
  return text
    .replace(MOBILE_PATTERN, '$1$2****$3')
    .replace(LANDLINE_PATTERN, '$1-****$3');
}

/**
 * 把一段文本里的邮箱、手机号与座机号遮掉，其余原样返回。
 * URL 里的数字串保持原样，所以按 URL 切开，只在非 URL 段遮号码。
 */
export function redactRecipientAddresses(text: string): string {
  return toHalfWidth(text)
    .split(URL_PATTERN)
    .map((part, index) =>
      index % 2 === 1 ? maskEmails(part) : maskEmails(maskPhones(part)),
    )
    .join('');
}
