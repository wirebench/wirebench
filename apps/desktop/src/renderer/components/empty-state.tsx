import type { ReactNode } from 'react';

export interface EmptyStateProps {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}

/** An empty region is an invitation to act, so it says what to do next, not that it is empty. */
export function EmptyState({ title, description, children }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="max-w-md">
        <h2 className="text-lg font-medium text-fg-default">{title}</h2>
        <p className="mt-1 text-md text-fg-muted">{description}</p>
      </div>
      {children}
    </div>
  );
}
