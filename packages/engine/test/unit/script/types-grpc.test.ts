/**
 * gRPC script types from a method's messages: the JSON form the engine reads and writes, typed —
 * 64-bit integers and bytes as strings, enums by name, maps, repeated and recursive messages, and
 * the well-known types — compiling with a script and catching a wrong field.
 */
import { describe, expect, it } from 'vitest';
import { loadProtoSet } from '../../../src/grpc/proto/load.js';
import { apiDeclarations, secretNameType } from '../../../src/script/types/api.js';
import { grpcScriptTypes } from '../../../src/grpc/script-types.js';
import { typeErrors } from './ts-check.js';

const PROTO = `
syntax = "proto3";
package shop.v1;
import "google/protobuf/timestamp.proto";
import "google/protobuf/wrappers.proto";

enum Status { STATUS_UNSPECIFIED = 0; OPEN = 1; CLOSED = 2; }

message Item {
  // The stock keeping unit.
  string sku = 1;
  int64 quantity = 2;
}

message Cart {
  string id = 1;
  repeated Item items = 2;
  map<string, int32> counts = 3;
  map<string, Status> statuses = 4;
  Status status = 5;
  bytes token = 6;
  google.protobuf.Timestamp created = 7;
  google.protobuf.Int64Value limit = 8;
  Cart parent = 9;
  oneof owner { string user = 10; string team = 11; }
  double total = 12;
}

message GetCartRequest { string cart_id = 1; }

service Carts { rpc Get(GetCartRequest) returns (Cart); }
`;

const set = loadProtoSet(new Map([['shop.proto', PROTO]]));
const declarations = (phase: 'pre' | 'post'): string =>
  apiDeclarations('grpc', phase) + secretNameType([]) + grpcScriptTypes(set, 'shop.v1.GetCartRequest', 'shop.v1.Cart');

describe('grpcScriptTypes', () => {
  it('maps each field kind to its JSON form', () => {
    const types = grpcScriptTypes(set, '.shop.v1.GetCartRequest', 'shop.v1.Cart');
    expect(types).toContain('type WbMsg_shop_v1_Cart = {');
    expect(types).toContain('  items?: WbMsg_shop_v1_Item[];');
    expect(types).toContain('  counts?: Record<string, number>;');
    expect(types).toContain('  statuses?: Record<string, "STATUS_UNSPECIFIED" | "OPEN" | "CLOSED">;');
    expect(types).toContain('  status?: "STATUS_UNSPECIFIED" | "OPEN" | "CLOSED";');
    expect(types).toContain('  token?: string;');
    expect(types).toContain('  created?: string;');
    expect(types).toContain('  limit?: string;');
    expect(types).toContain('  parent?: WbMsg_shop_v1_Cart;');
    expect(types).toContain('  quantity?: string;');
    expect(types).toContain('  /** The stock keeping unit. */\n  sku?: string;');
    expect(types).toContain('type WbRequestMessage = WbMsg_shop_v1_GetCartRequest;');
    expect(types).toContain('type WbResponseMessage = WbMsg_shop_v1_Cart;');
  });

  it('compiles with a script, and catches a wrong field', () => {
    const ok = `
      const cart = response.message;
      if (cart !== undefined) {
        const first: string | undefined = cart.items?.[0]?.quantity;
        const open: boolean = cart.status === 'OPEN';
        const parentId: string | undefined = cart.parent?.parent?.id;
        log(first, open, parentId, cart.counts?.['a'], response.status.code, request.message.cart_id);
      }
    `;
    expect(typeErrors(declarations('post'), ok)).toEqual([]);
    const bad = `
      log(response.message?.itemz);
      const n: number | undefined = response.message?.items?.[0]?.quantity;
      if (response.message?.status === 'PENDING') {}
    `;
    const errors = typeErrors(declarations('post'), bad);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/'itemz' does not exist/);
  });

  it('types the request message a pre-request script sets', () => {
    expect(
      typeErrors(declarations('pre'), 'request.message = { cart_id: "7" }; request.metadata.set("x", "1");'),
    ).toEqual([]);
    expect(typeErrors(declarations('pre'), 'request.message = { cartId: 7 };')).toHaveLength(1);
  });

  it('leaves the messages untyped without a proto set, and survives an unknown type', () => {
    expect(grpcScriptTypes(undefined, 'a.B', 'a.C')).toContain('type WbRequestMessage = unknown;');
    expect(grpcScriptTypes(set, 'shop.v1.Missing', 'shop.v1.Cart')).toContain('type WbMsg_shop_v1_Missing = unknown;');
  });
});
