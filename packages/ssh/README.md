# @wirebench/ssh

Node-only SSH support for Wirebench: the `hosts.yaml` inventory (groups, inheritance, jump hosts) and, in later
slices, SSH sessions. It imports neither `@wirebench/engine` nor Electron, and the engine never imports it.
Credentials are always `${secret:NAME}` tokens; this package never holds a resolved secret in a file.
