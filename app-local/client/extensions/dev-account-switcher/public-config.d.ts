/**
 * `devTools` 发布到客户端的字段，与 `server/config/dev-tools.ts` 的 `public` 保持一致。
 *
 * 拼错路径或值类型不在这里写清楚，`config.public.get()` 会在运行时静默读到 `undefined`；
 * 有这一段，typecheck 当场报错。
 */
declare module '@nocobase/app-client' {
  interface PublicAppConfig {
    devTools: {
      accountSwitcher?: {
        enabled?: boolean;
      };
    };
  }
}

// 有这一行，这个文件才是模块，上面才是「合并到已有模块」而不是「重新声明一个模块」。
export {};
