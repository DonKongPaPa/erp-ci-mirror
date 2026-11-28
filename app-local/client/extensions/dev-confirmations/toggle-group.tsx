import * as React from 'react';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

/**
 * 移植自 shadcn/ui 官方仓库的 Toggle 与 Toggle Group
 * （`apps/v4/registry/bases/base/ui/toggle.tsx`、`toggle-group.tsx`，
 * https://github.com/shadcn-ui/ui ，MIT，读取于 2026-11-28）。用来做分段按钮（单选的一组）。
 *
 * 为什么放在这个扩展的目录里：`components/ui` 没有装 toggle / toggle-group，本任务不许加依赖、
 * 也不许往 `components/ui` 里放文件；底层 `@base-ui/react/toggle`、`toggle-group` 已经是现有依赖。
 * 官方源码的样式写在它自己的样式表 `cn-toggle-*` 类里，这里把
 * `apps/v4/registry/styles/style-nova.css` 对应的 `@apply` 内容展开成类名。
 * 与官方的差异，都有意为之：
 *   - 只留 `size`，去掉 `variant` 与 `spacing`：分段按钮只用默认外观、按钮之间不留缝。
 *   - 外层加 `bg-muted p-0.75`、选中项加白底与阴影：照本项目已装的 TabsList / TabsTrigger 的
 *     选中态写，分段按钮才看得出「当前在哪一段」（官方默认的选中态只是浅灰底）。
 *   - 间距用 `gap-0.5` 代替官方的 `gap-[--spacing(var(--gap))]`。
 */

const toggleVariants = cva(
  'inline-flex items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap outline-none transition-all hover:text-foreground focus-visible:z-10 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      size: {
        default: 'h-8 min-w-8 px-2.5',
        sm: 'h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-2.5',
        lg: 'h-9 min-w-9 px-2.5',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants>
>({
  size: 'default',
});

function ToggleGroup({
  className,
  size = 'default',
  children,
  ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <ToggleGroupPrimitive
      data-slot='toggle-group'
      data-size={size}
      className={cn(
        'group/toggle-group flex w-fit flex-row items-center gap-0.5 rounded-lg bg-muted p-0.75',
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

function ToggleGroupItem({
  className,
  children,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext);
  return (
    <TogglePrimitive
      data-slot='toggle-group-item'
      data-size={context.size || size}
      className={cn(
        toggleVariants({ size: context.size || size }),
        'shrink-0',
        className,
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
}

export { ToggleGroup, ToggleGroupItem };
