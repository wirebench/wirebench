# Manual tests: device keys and app lock (#428)

The prompts these features show (Touch ID, the login password, Windows Hello) cannot be answered in CI, so each
platform is checked by hand on a packaged build. Record the date, build and result of each row, and file an
issue for any failure.

## macOS (Secure Enclave)

| #   | Step                                                                           | Expected                                                                                                      | Result |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Keychain → Generate key… → Device key (This Mac's Secure Enclave)               | No passphrase fields; the recovery warning shows; the key is listed as `ecdsa 256` with a "this device" badge | —      |
| M2  | Install on host… with the new key, on a test host                              | Installed over the host's current sign-in; no prompt                                                          | —      |
| M3  | Switch the host to the key and connect                                         | macOS asks for Touch ID, naming the sign-in; the terminal opens after it                                      | —      |
| M4  | Connect again and use the password instead of Touch ID                         | Signs in                                                                                                      | —      |
| M5  | Connect again and cancel the prompt                                            | The connection screen says the prompt was cancelled; Retry asks again                                         | —      |
| M6  | Copy the key's secret value to another Mac (or another user) and connect there | Fails with "made on …"; the keychain shows "other device (…)"                                                 | —      |
| M7  | `wirebench` CLI run against the host                                           | Fails with `ssh-device-key-unavailable`                                                                       | —      |
| A1  | Settings → Secrets → App lock on                                               | Asks once; the switch turns on only after the prompt is passed                                                | —      |
| A2  | Quit, start the app and connect to a password host                             | Asks once before the connect; a second connect does not ask                                                   | —      |
| A3  | Set idle to 1 minute, leave the machine for 2 minutes, connect                 | Asks again                                                                                                    | —      |
| A4  | Lock the screen, unlock it, connect                                            | Asks again                                                                                                    | —      |
| A5  | Cancel the app lock prompt                                                     | The connect fails with "Wirebench is locked"; REST requests still send                                        | —      |
| A6  | Turn the app lock off                                                          | No prompt; connects no longer ask                                                                             | —      |

## Windows (Windows Hello, experimental)

| #   | Step                                                      | Expected                                                         | Result |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| W1  | Generate key… → Device key (Windows Hello)                | Windows Hello asks (in front of the app); the key is listed as `rsa` | —      |
| W2  | Install it on a test host, switch the host to it, connect | Windows Hello asks; signs in (the server accepts `rsa-sha2-256`)  | —      |
| W3  | Cancel the Hello prompt                                   | The connection screen says the prompt was cancelled              | —      |
| W4  | App lock rows A1 to A6                                    | As on macOS, with Windows Hello                                  | —      |

## Linux

| #   | Step                          | Expected                                | Result |
| --- | ----------------------------- | --------------------------------------- | ------ |
| L1  | Generate key…                 | Device key is disabled, with the reason | —      |
| L2  | Settings → Secrets → App lock | The switch is disabled, with the reason | —      |
