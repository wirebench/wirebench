/**
 * The gRPC response pane: the status line leads with the gRPC status (not the HTTP code every call
 * comes back with), the messages are listed in order, a message that did not decode says why, and
 * the metadata tab keeps headers and trailers apart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GrpcResponsePane, grpcStatusToneClass } from '../../src/renderer/features/grpc-editor/response-pane.js';
import { makeGrpcExchange, b64 } from '../mocks/exchange-fixtures.js';

afterEach(cleanup);

describe('GrpcResponsePane', () => {
  it('asks for a send before there is one, and says so while sending', () => {
    const { rerender } = render(<GrpcResponsePane state={undefined} />);
    expect(screen.getByText('Send the request to see its response.')).toBeTruthy();

    rerender(<GrpcResponsePane state={{ status: 'sending', sendId: 's' }} />);
    expect(screen.getByTestId('grpc-response-status').textContent).toBe('Sending…');
  });

  it('leads with the gRPC status and counts the messages', () => {
    render(<GrpcResponsePane state={{ status: 'done', sendId: 's', exchange: makeGrpcExchange() }} />);

    const status = screen.getByTestId('grpc-response-status').textContent ?? '';
    expect(status).toContain('OK (0)');
    expect(status).toContain('1 message');
    expect(screen.getAllByTestId('grpc-response-message')).toHaveLength(1);
    expect(screen.getByTestId('grpc-response-messages').textContent).toContain('"message": "Hello, Ada"');
  });

  it('shows a non-OK status with its message, and a trailers-only reply as such', () => {
    render(
      <GrpcResponsePane
        state={{
          status: 'done',
          sendId: 's',
          exchange: makeGrpcExchange({
            status: 5,
            statusName: 'NOT_FOUND',
            statusMessage: 'no such user',
            statusSource: 'headers',
            responseMessages: [],
          }),
        }}
      />,
    );

    const status = screen.getByTestId('grpc-response-status').textContent ?? '';
    expect(status).toContain('NOT_FOUND (5)');
    expect(status).toContain('no such user');
    expect(status).toContain('trailers-only');
    expect(status).toContain('0 messages');
  });

  it('reports a message that did not decode, with its bytes', () => {
    render(
      <GrpcResponsePane
        state={{
          status: 'done',
          sendId: 's',
          exchange: makeGrpcExchange({
            responseMessages: [{ base64: b64('xx'), bytes: 2, problem: 'not a HelloReply' }],
          }),
        }}
      />,
    );

    expect(screen.getByText('not a HelloReply')).toBeTruthy();
  });

  it('keeps headers and trailers apart on the Metadata tab', () => {
    render(<GrpcResponsePane state={{ status: 'done', sendId: 's', exchange: makeGrpcExchange() }} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Metadata' }));

    expect(screen.getAllByTestId('grpc-response-header-row')).toHaveLength(2);
    expect(screen.getAllByTestId('grpc-response-trailer-row')).toHaveLength(1);
    expect(screen.getByTestId('grpc-response-metadata').textContent).toContain('grpc-status');
  });

  it('shows a transport error in the status line', () => {
    render(
      <GrpcResponsePane
        state={{ status: 'error', sendId: 's', error: { code: 'econnrefused', message: 'refused' } }}
      />,
    );
    expect(screen.getByTestId('grpc-response-status').textContent).toContain('econnrefused');
  });

  it('colours OK green, a local deadline amber and everything else red', () => {
    expect(grpcStatusToneClass({ status: 0, statusSource: 'trailers' })).toBe('text-status-success');
    expect(grpcStatusToneClass({ status: 4, statusSource: 'local' })).toBe('text-status-warning');
    expect(grpcStatusToneClass({ status: 13, statusSource: 'trailers' })).toBe('text-status-danger');
  });
});

/** One decoded message as main puts it on the wire. */
function live(json: string) {
  return { json, base64: b64(json), bytes: json.length };
}

describe('a call that is still running', () => {
  it('shows the messages that have arrived, before there is an exchange', () => {
    render(
      <GrpcResponsePane
        state={{
          status: 'sending',
          sendId: 's',
          live: { messages: [live('{"message":"Hello #1"}')], sent: [], open: false },
        }}
      />,
    );

    // The tab strip is up while the call runs, rather than only after it ends.
    expect(screen.getByRole('tablist', { name: 'Response tabs' })).toBeTruthy();
    expect(screen.getAllByTestId('grpc-response-message')).toHaveLength(1);
    expect(screen.getByTestId('grpc-response-status').textContent).toContain('1 message');
  });

  it('says it is waiting before the first message', () => {
    render(
      <GrpcResponsePane state={{ status: 'sending', sendId: 's', live: { messages: [], sent: [], open: false } }} />,
    );

    expect(screen.getByText('Waiting for the first message…')).toBeTruthy();
    expect(screen.getByTestId('grpc-response-status').textContent).toBe('Sending…');
  });

  it('shows the initial metadata before the trailers exist', () => {
    render(
      <GrpcResponsePane
        state={{
          status: 'sending',
          sendId: 's',
          live: { messages: [], sent: [], open: false, headers: { 'content-type': 'application/grpc' } },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Metadata' }));

    expect(screen.getAllByTestId('grpc-response-header-row')).toHaveLength(1);
    expect(screen.getByText('The trailers arrive when the call ends.')).toBeTruthy();
  });

  it('offers the composer only while the request side is open', () => {
    const onPush = vi.fn();
    const onHalfClose = vi.fn();
    const { rerender } = render(
      <GrpcResponsePane
        state={{ status: 'sending', sendId: 's', live: { messages: [], sent: [], open: false } }}
        onPush={onPush}
        onHalfClose={onHalfClose}
      />,
    );
    expect(screen.queryByTestId('grpc-stream-composer')).toBeNull();

    rerender(
      <GrpcResponsePane
        state={{ status: 'sending', sendId: 's', live: { messages: [], sent: [], open: true } }}
        onPush={onPush}
        onHalfClose={onHalfClose}
      />,
    );

    fireEvent.change(screen.getByTestId('grpc-stream-message'), { target: { value: '{"name":"Ada"}' } });
    fireEvent.click(screen.getByTestId('grpc-stream-send'));
    expect(onPush).toHaveBeenCalledWith('{"name":"Ada"}');

    fireEvent.click(screen.getByTestId('grpc-half-close'));
    expect(onHalfClose).toHaveBeenCalledTimes(1);
  });

  it('will not send an empty message', () => {
    const onPush = vi.fn();
    render(
      <GrpcResponsePane
        state={{ status: 'sending', sendId: 's', live: { messages: [], sent: [], open: true } }}
        onPush={onPush}
        onHalfClose={() => undefined}
      />,
    );

    fireEvent.change(screen.getByTestId('grpc-stream-message'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('grpc-stream-send'));

    expect(onPush).not.toHaveBeenCalled();
  });

  it('counts what has been sent on the composer', () => {
    render(
      <GrpcResponsePane
        state={{ status: 'sending', sendId: 's', live: { messages: [], sent: ['{}', '{}'], open: true } }}
        onPush={() => undefined}
        onHalfClose={() => undefined}
      />,
    );

    expect(screen.getByTestId('grpc-stream-composer').textContent).toContain('2 sent');
  });
});
