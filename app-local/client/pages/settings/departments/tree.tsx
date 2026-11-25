import { useTranslation } from '@nocobase/i18n/client';
import { ChevronRight } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from 'cn';

import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '#components/ui/collapsible';
import { StatusBadge } from '#components/status-badge';

import type { DepartmentNode } from './client.js';

export interface DepartmentTreeProps {
  readonly nodes: readonly DepartmentNode[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}

/** 整棵部门树的折叠面板。每个部门一行：名称、编码、类型、停用标记。 */
export function DepartmentTree({
  nodes,
  selectedId,
  onSelect,
}: DepartmentTreeProps): ReactElement {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('departments.tree')}>
      <ul className='flex flex-col gap-0.5'>
        {nodes.map((node) => (
          <TreeItem
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </nav>
  );
}

function TreeItem({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  readonly node: DepartmentNode;
  readonly depth: number;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const selected = node.id === selectedId;
  const hasChildren = node.children.length > 0;
  return (
    <li>
      <Collapsible defaultOpen>
        <div
          className='flex items-center gap-1'
          style={{ paddingInlineStart: `${depth * 0.75}rem` }}
        >
          {hasChildren ? (
            <CollapsibleTrigger
              render={
                <Button
                  variant='ghost'
                  size='icon-xs'
                  aria-label={t('departments.toggle', { title: node.title })}
                  className='[&[data-panel-open]>svg]:rotate-90'
                />
              }
            >
              <ChevronRight
                aria-hidden='true'
                className='transition-transform'
              />
            </CollapsibleTrigger>
          ) : (
            <span aria-hidden='true' className='size-6 shrink-0' />
          )}
          <Button
            variant='ghost'
            aria-current={selected ? 'true' : undefined}
            className={cn(
              'h-auto min-w-0 flex-1 flex-wrap justify-start gap-2 px-2 py-1.5 text-left font-normal whitespace-normal',
              selected && 'bg-muted text-foreground',
            )}
            onClick={() => onSelect(node.id)}
          >
            <span className='min-w-0 font-medium break-words'>
              {node.title}
            </span>
            <Badge variant='secondary' data-size='sm'>
              {node.code}
            </Badge>
            <Badge variant='outline' data-size='sm'>
              {t(`departments.kind.${node.kind}`, {
                defaultValue: node.kind,
              })}
            </Badge>
            {node.active ? null : (
              <StatusBadge size='sm' tone='neutral'>
                {t('departments.inactive')}
              </StatusBadge>
            )}
          </Button>
        </div>
        {hasChildren ? (
          <CollapsibleContent>
            <ul className='flex flex-col gap-0.5'>
              {node.children.map((child) => (
                <TreeItem
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  selectedId={selectedId}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </li>
  );
}
