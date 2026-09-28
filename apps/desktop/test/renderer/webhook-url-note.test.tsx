import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WebhookUrlNote } from '../../src/renderer/features/webhook-items/webhook-url-note.js';

describe('WebhookUrlNote', () => {
  it('shows where a target send goes', () => {
    render(
      <WebhookUrlNote resolvedUrl="https://my-app.dev/hooks/newPet" source="target" onOpenSettings={() => undefined} />,
    );
    expect(screen.getByText('→ https://my-app.dev/hooks/newPet')).toBeTruthy();
  });

  it('says where a callback URL came from', () => {
    render(
      <WebhookUrlNote
        resolvedUrl="https://my-app.dev/subs/cb-91"
        source="callback"
        detail="from your last POST /subscriptions (10:42)"
        onOpenSettings={() => undefined}
      />,
    );
    expect(screen.getByText(/from your last POST \/subscriptions \(10:42\)/)).toBeTruthy();
  });

  it('offers the settings when the target is missing', () => {
    const open = vi.fn();
    render(<WebhookUrlNote source="missing" onOpenSettings={open} />);
    expect(screen.getByText('Set the Webhooks target')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings…' }));
    expect(open).toHaveBeenCalled();
  });
});
