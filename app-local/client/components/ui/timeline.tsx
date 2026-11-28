import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

/**
 * 竖向时间线，移植自 shadcn 系的开源实现 timDeHof/shadcn-timeline
 * （https://github.com/timDeHof/shadcn-timeline，`src/components/timeline/timeline.tsx`，MIT）。
 *
 * 组件名、结构、连接线的做法与原来一致。按本项目改了四处：
 * - 原实现每一条都是 `motion.li`，加载态与出错态也靠 framer-motion；本项目没有这个依赖、也用不上这两种状态，
 *   所以去掉 motion 与这两个状态，条目就是普通的 `<li>`。
 * - 去掉 `TimelineEmpty` 里的英文写死文案（空状态由页面用 `Empty` 显示）。
 * - 去掉 `min-h-[600px] mx-auto max-w-2xl`（它为整页设计；这里放在抽屉里），圆点的描边跟随所在的浮层。
 * - 不再用 `Children.map` + `cloneElement` 往每一条里塞 `iconsize` 与「是不是最后一条」（本项目的
 *   可访问性 lint 把这几个 API 当成警告）：`iconsize` 走 context，最后一条自己判断。
 * - 没给 `title` 时不渲染空的标题行（时间线的每一条只有时间与正文）。
 */

const timelineVariants = cva('flex flex-col relative', {
  variants: {
    size: {
      sm: 'gap-4',
      md: 'gap-6',
      lg: 'gap-8',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

interface TimelineProps
  extends
    React.HTMLAttributes<HTMLOListElement>,
    VariantProps<typeof timelineVariants> {
  /** Size of the timeline icons */
  iconsize?: 'sm' | 'md' | 'lg';
}

interface TimelineContextValue {
  readonly iconsize?: 'sm' | 'md' | 'lg';
}

const TimelineContext = React.createContext<TimelineContextValue>({});

/** Timeline component for displaying a vertical list of events or items */
function Timeline({
  className,
  iconsize,
  size,
  children,
  ...props
}: TimelineProps): React.ReactElement {
  return (
    <ol
      className={cn(
        timelineVariants({ size }),
        'relative w-full py-2',
        className,
      )}
      {...props}
    >
      <TimelineContext.Provider value={{ iconsize }}>
        {children}
      </TimelineContext.Provider>
    </ol>
  );
}
Timeline.displayName = 'Timeline';

interface TimelineItemProps extends React.HTMLAttributes<HTMLLIElement> {
  /** Date string for the timeline item */
  date?: string;
  /** Title of the timeline item */
  title?: string;
  /** Description text */
  description?: string;
  /** Custom icon element */
  icon?: React.ReactNode;
  /** Color theme for the icon */
  iconColor?: 'primary' | 'secondary' | 'muted' | 'accent' | 'destructive';
  /** Current status of the item */
  status?: 'completed' | 'in-progress' | 'pending';
  /** Color theme for the connector line */
  connectorColor?: 'primary' | 'secondary' | 'muted' | 'accent';
  /** Whether to show the connector line; off by default on the last item */
  showConnector?: boolean;
}

function TimelineItem({
  className,
  date,
  title,
  description,
  icon,
  iconColor,
  status = 'completed',
  connectorColor,
  showConnector,
  ...props
}: TimelineItemProps): React.ReactElement {
  const { iconsize } = React.useContext(TimelineContext);
  const ref = React.useRef<HTMLLIElement>(null);
  // 自己是不是最后一条：挂上去之后问一次父元素，不用上游的 cloneElement。
  const [isLast, setIsLast] = React.useState(false);
  React.useEffect(() => {
    setIsLast(ref.current === ref.current?.parentElement?.lastElementChild);
  }, []);

  return (
    <li ref={ref} className={cn('relative w-full', className)} {...props}>
      <div
        className='grid grid-cols-[1fr_auto_1fr] items-start gap-4'
        {...(status === 'in-progress' ? { 'aria-current': 'step' } : {})}
      >
        {/* Date */}
        <div className='flex min-w-0 flex-col justify-start pt-0.5'>
          <TimelineTime className='pr-4 text-right'>{date}</TimelineTime>
        </div>

        {/* Timeline dot and connector */}
        <div className='flex flex-col items-center'>
          <div className='relative z-10'>
            <TimelineIcon
              icon={icon}
              color={iconColor}
              status={status}
              iconSize={iconsize}
            />
          </div>
          {(showConnector ?? !isLast) && (
            <TimelineConnector
              status={status}
              color={connectorColor}
              className='mt-2 h-16'
            />
          )}
        </div>

        {/* Content */}
        <TimelineContent>
          {title ? (
            <TimelineHeader>
              <TimelineTitle>{title}</TimelineTitle>
            </TimelineHeader>
          ) : null}
          <TimelineDescription>{description}</TimelineDescription>
        </TimelineContent>
      </div>
    </li>
  );
}
TimelineItem.displayName = 'TimelineItem';

interface TimelineTimeProps extends React.HTMLAttributes<HTMLElement> {
  /** Date string, Date object, or timestamp */
  date?: string | Date | number;
  /** Optional format for displaying the date */
  format?: Intl.DateTimeFormatOptions;
}

const defaultDateFormat: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
};

function TimelineTime({
  className,
  date,
  format,
  children,
  ...props
}: TimelineTimeProps): React.ReactElement {
  const formattedDate = React.useMemo(() => {
    if (!date) return '';

    const dateObj = new Date(date);
    if (Number.isNaN(dateObj.getTime())) return '';

    try {
      return new Intl.DateTimeFormat('en-US', {
        ...defaultDateFormat,
        ...format,
      }).format(dateObj);
    } catch {
      return '';
    }
  }, [date, format]);

  return (
    <time
      className={cn(
        'text-xs font-medium tracking-tight text-muted-foreground tabular-nums',
        className,
      )}
      dateTime={date ? new Date(date).toISOString() : undefined}
      {...props}
    >
      {children || formattedDate}
    </time>
  );
}
TimelineTime.displayName = 'TimelineTime';

interface TimelineConnectorProps extends React.HTMLAttributes<HTMLDivElement> {
  status?: 'completed' | 'in-progress' | 'pending';
  color?: 'primary' | 'secondary' | 'muted' | 'accent';
}

function TimelineConnector({
  className,
  status = 'completed',
  color,
  ...props
}: TimelineConnectorProps): React.ReactElement {
  return (
    <div
      data-slot='timeline-connector'
      className={cn(
        'w-0.5',
        {
          'bg-primary':
            color === 'primary' || (!color && status === 'completed'),
          'bg-muted': color === 'muted' || (!color && status === 'pending'),
          'bg-secondary': color === 'secondary',
          'bg-accent': color === 'accent',
          'bg-gradient-to-b from-primary to-muted':
            !color && status === 'in-progress',
        },
        className,
      )}
      {...props}
    />
  );
}
TimelineConnector.displayName = 'TimelineConnector';

function TimelineHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-4', className)} {...props} />
  );
}
TimelineHeader.displayName = 'TimelineHeader';

function TimelineTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
  return (
    <h4
      className={cn(
        'font-semibold leading-none tracking-tight text-secondary-foreground',
        className,
      )}
      {...props}
    />
  );
}
TimelineTitle.displayName = 'TimelineTitle';

function TimelineIcon({
  icon,
  color = 'primary',
  status: _status,
  iconSize = 'md',
}: {
  icon?: React.ReactNode;
  color?: 'primary' | 'secondary' | 'muted' | 'accent' | 'destructive';
  status?: 'completed' | 'in-progress' | 'pending' | 'error';
  iconSize?: 'sm' | 'md' | 'lg';
}): React.ReactElement {
  const sizeClasses = {
    sm: 'h-6 w-6',
    md: 'h-8 w-8',
    lg: 'h-10 w-10',
  };

  const iconSizeClasses = {
    sm: 'h-3.5 w-3.5',
    md: 'h-4 w-4',
    lg: 'h-5 w-5',
  };

  const colorClasses = {
    primary: 'bg-primary text-primary-foreground',
    secondary: 'bg-secondary text-secondary-foreground',
    muted: 'bg-muted text-muted-foreground',
    accent: 'bg-accent text-accent-foreground',
    destructive: 'bg-destructive text-destructive-foreground',
  };

  return (
    <div
      data-slot='timeline-icon'
      className={cn(
        'relative flex items-center justify-center rounded-full ring-4 ring-popover shadow-sm',
        sizeClasses[iconSize],
        colorClasses[color],
      )}
    >
      {icon ? (
        <div
          className={cn(
            'flex items-center justify-center',
            iconSizeClasses[iconSize],
          )}
        >
          {icon}
        </div>
      ) : (
        <div className={cn('rounded-full', iconSizeClasses[iconSize])} />
      )}
    </div>
  );
}

function TimelineDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.ReactElement {
  return (
    <p
      className={cn(
        'max-w-2xl text-sm break-words text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
TimelineDescription.displayName = 'TimelineDescription';

function TimelineContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-1 py-0.5 pr-2', className)}
      {...props}
    />
  );
}
TimelineContent.displayName = 'TimelineContent';

export {
  Timeline,
  TimelineItem,
  TimelineConnector,
  TimelineHeader,
  TimelineTitle,
  TimelineIcon,
  TimelineDescription,
  TimelineContent,
  TimelineTime,
};
