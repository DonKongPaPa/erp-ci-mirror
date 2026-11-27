import type { ReactElement, ReactNode } from 'react';

import { FieldGroup } from '#components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { cn } from 'cn';

/** 物料页的几个表单共用的小件：一个下拉、一列字段。 */

export interface FormOption {
  readonly value: string;
  readonly label: string;
}

/**
 * 表单里的下拉：标签与报错由外层的 `FormField` 出，这里只管触发器与选项。
 * `id` 接 `FormField` 给的，标签才对得上这一个控件。
 */
export function FormSelect({
  id,
  invalid,
  value,
  options,
  onChange,
  className,
}: {
  readonly id: string;
  readonly invalid: boolean;
  readonly value: string;
  readonly options: readonly FormOption[];
  readonly onChange: (value: string) => void;
  readonly className?: string;
}): ReactElement {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => onChange(String(next))}
    >
      <SelectTrigger
        id={id}
        aria-invalid={invalid}
        className={cn('w-full', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 窄对话框里的字段：一列，一行一个。 */
export function FormRows({ children }: { readonly children: ReactNode }) {
  return <FieldGroup className='flex flex-col gap-4'>{children}</FieldGroup>;
}
