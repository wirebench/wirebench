/**
 * The gRPC response pane: the status line leads with the gRPC status (not the HTTP code every call
 * comes back with), the messages are listed in order, a message that did not decode says why, and
 * the metadata tab keeps headers and trailers apart.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
