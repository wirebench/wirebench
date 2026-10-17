// Wirebench's device helper for macOS (#428): makes and uses SSH keys held by the Secure Enclave.
//
// One command per run: `status`, `create`, `check`, `sign` or `unlock` as the first argument, one JSON request on
// stdin, one JSON answer on stdout, exit 0 or 1. An error answer is `{ "error": code, "message": text }`
// with code `cancelled`, `missing`, `unsupported` or `failed`. Nothing is written to stderr.
//
// A key is a CryptoKit Secure Enclave key: its `dataRepresentation` is a blob only this Mac's enclave can
// open, so the handle Wirebench stores is useless anywhere else. Its access control asks for the user's
// presence (Touch ID, or the login password) on every signature. No keychain item is made, so no
// entitlement is needed.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

func respond(_ answer: [String: Any], code: Int32) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: answer)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    exit(code)
}

func fail(_ error: String, _ message: String) -> Never {
    respond(["error": error, "message": message], code: 1)
}

func readRequest() -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    if String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [:] }
    guard let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        fail("failed", "The request is not a JSON object")
    }
    return request
}

func field(_ request: [String: Any], _ name: String) -> String {
    guard let value = request[name] as? String, !value.isEmpty else { fail("failed", "The request has no \(name)") }
    return value
}

func bytes(_ request: [String: Any], _ name: String) -> Data {
    guard let data = Data(base64Encoded: field(request, name)) else { fail("failed", "The \(name) is not base64") }
    return data
}

/// True for an error that means the person dismissed the prompt, however deeply it is wrapped.
func isCancel(_ error: Error) -> Bool {
    var current: NSError? = error as NSError
    let cancels = [LAError.userCancel, .systemCancel, .appCancel, .userFallback].map(\.rawValue)
    while let ns = current {
        if ns.domain == LAErrorDomain, cancels.contains(ns.code) { return true }
        if ns.domain == NSOSStatusErrorDomain, ns.code == Int(errSecUserCanceled) { return true }
        current = ns.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return false
}

/// Asks for the device owner (Touch ID, or the login password) with `reason`; the context then signs
/// without asking again.
func authenticate(_ context: LAContext, _ reason: String) {
    var policyError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
        fail("unsupported", "This Mac cannot ask for Touch ID or the password")
    }
    let done = DispatchSemaphore(value: 0)
    var outcome: Error?
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
        if !success { outcome = error ?? NSError(domain: LAErrorDomain, code: LAError.authenticationFailed.rawValue) }
        done.signal()
    }
    done.wait()
    if let error = outcome {
        if isCancel(error) { fail("cancelled", "The prompt was cancelled") }
        fail("failed", "Authentication failed: \(error.localizedDescription)")
    }
}

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let request = readRequest()

switch command {
case "status":
    if SecureEnclave.isAvailable { respond(["supported": true], code: 0) }
    respond(["supported": false, "reason": "This Mac has no Secure Enclave"], code: 0)

case "create":
    guard SecureEnclave.isAvailable else { fail("unsupported", "This Mac has no Secure Enclave") }
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &accessError
    ) else {
        fail("failed", "The key's access control could not be made")
    }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        respond([
            "publicKey": key.publicKey.x963Representation.base64EncodedString(),
            "handle": key.dataRepresentation.base64EncodedString(),
        ], code: 0)
    } catch {
        // A key that needs the Mac unlocked cannot be made while it is locked.
        if (error as NSError).code == Int(errSecInteractionNotAllowed) { fail("failed", "Unlock this Mac and try again") }
        fail("failed", "The Secure Enclave did not make the key: \(error.localizedDescription)")
    }

case "check":
    // Whether this Mac's enclave can open the handle; loading it asks for nothing.
    guard SecureEnclave.isAvailable else { respond(["present": false], code: 0) }
    let opened = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: bytes(request, "handle"))
    respond(["present": opened != nil], code: 0)

case "sign":
    guard SecureEnclave.isAvailable else { fail("unsupported", "This Mac has no Secure Enclave") }
    let handle = bytes(request, "handle")
    let data = bytes(request, "data")
    let reason = field(request, "reason")
    let context = LAContext()
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
        key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: handle, authenticationContext: context)
    } catch {
        fail("missing", "This Mac's Secure Enclave cannot open the key")
    }
    authenticate(context, reason)
    do {
        let signature = try key.signature(for: data)
        respond(["signature": signature.rawRepresentation.base64EncodedString()], code: 0)
    } catch {
        if isCancel(error) { fail("cancelled", "The prompt was cancelled") }
        fail("failed", "The Secure Enclave did not sign: \(error.localizedDescription)")
    }

case "unlock":
    authenticate(LAContext(), field(request, "reason"))
    respond(["ok": true], code: 0)

default:
    fail("failed", "Unknown command \(command)")
}
