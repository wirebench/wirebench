# Proto fixtures

Hand-written `.proto` files for the gRPC tests. `crafted/greeter/` is the service the engine's unit
and integration tests, the desktop tests and the e2e suite all import; it exercises every message
shape the client has to handle (nested imports, well-known types, `oneof`, maps, `optional`, enums,
64-bit integers, bytes) and every streaming shape a method can have. `crafted/broken/` does not
parse, and `crafted/no-package/` declares no package.
