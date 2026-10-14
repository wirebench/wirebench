import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

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

export interface ActionEmptyStateProps {
  readonly icon: LucideIcon;
  /** One sentence on the task the place is for. */
  readonly text: string;
  /** The buttons that take the first step, the primary one first: they take focus in this order. */
  readonly children: ReactNode;
  readonly testId?: string;
}

/**
 * A view or page with nothing in it yet: what it is for, and the buttons that add the first thing. One card
 * for every area, so an empty Hosts view and an empty project read the same and offer their next step the
 * same way. The buttons wrap rather than overflow in a narrow sidebar.
 */
export function ActionEmptyState({ icon: Icon, text, children, testId }: ActionEmptyStateProps) {
  return (
    <div
      data-testid={testId ?? 'empty-state'}
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-hairline-strong px-6 py-12 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-xl bg-accent-muted text-fg-default">
        <Icon size={22} aria-hidden="true" />
      </span>
      <p className="max-w-sm text-sm text-fg-muted">{text}</p>
      <div className="flex flex-wrap justify-center gap-2">{children}</div>
    </div>
  );
}
