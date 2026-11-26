/**
 * 通知记录页显示渠道报错之前遮掉收件地址。
 *
 * 实现与 R-002 的代填共用一份：形状判定、全角折叠与座机都写在
 * `shared/redact-addresses.ts`，这里只保留原来的出口，调用方不用改。
 */

export { redactRecipientAddresses } from '../../shared/redact-addresses.js';
