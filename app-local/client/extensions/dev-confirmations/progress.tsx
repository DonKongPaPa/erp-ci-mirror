import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { cn } from 'cn';

/**
 * 移植自 shadcn/ui 官方仓库的 Progress（`apps/v4/registry/bases/base/ui/progress.tsx`，
 * https://github.com/shadcn-ui/ui ，MIT，读取于 2026-11-28）。
 *
 * 为什么放在这个扩展的目录里：`components/ui` 没有装 progress，本任务不许加依赖、也不许往
 * `components/ui` 里放文件；底层 `@base-ui/react/progress` 已经是现有依赖，所以照官方源码的结构
 * 移植到这儿。官方源码的样式写在它自己的样式表 `cn-progress-*` 类里，这里把
 * `apps/v4/registry/styles/style-nova.css` 对应的 `@apply` 内容原样展开成类名：
 *   cn-progress-track    bg-muted h-1 rounded-full
 *   cn-progress-indicator bg-primary
 *   cn-progress-label    text-sm font-medium
 *   cn-progress-value    text-muted-foreground ml-auto text-sm tabular-nums
 * 并按本项目的样式守门把 `ring-[3px]` 一类写法换成档位（这里没有用到）。
 */

function Progress({
  className,
  children,
  value,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot='progress'
      className={cn('flex flex-wrap gap-3', className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      data-slot='progress-track'
      className={cn(
        'relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted',
        className,
      )}
      {...props}
    />
  );
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot='progress-indicator'
      className={cn('h-full bg-primary transition-all', className)}
      {...props}
    />
  );
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      data-slot='progress-label'
      className={cn('text-sm font-medium', className)}
      {...props}
    />
  );
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      data-slot='progress-value'
      className={cn(
        'ml-auto text-sm text-muted-foreground tabular-nums',
        className,
      )}
      {...props}
    />
  );
}

export {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
};
