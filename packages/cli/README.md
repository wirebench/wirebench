# @wirebench/cli

```
npx @wirebench/cli run ./project --env ci
```

Runs a project's SOAP, REST and unary gRPC requests and their assertions; OAuth2 client-credentials
tokens are fetched headlessly, with the client secret from `WIREBENCH_SECRET_<NAME>`.

Requires Node 24 or later. See [`docs/cli.md`](https://github.com/wirebench/wirebench/blob/main/docs/cli.md) for the full command reference.
