/**
 * The public keys a license is verified against (licensing spec §3.2). Compiled in on purpose: there is
 * no environment variable for a key, so configuration can never mint an edition. The private half is
 * held offline by the owner and never enters this repository (ADR-0018). A rotation ships a release
 * with both keys; a retired key's constant is removed a version after the release notes announce it.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';

/** Key 1, generated 2026-10-02. */
const KEY_1 = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2pWmQuVYkbB9aqq+V5Hrg1/MzAqSZbSTdDuYLJN80AU=
-----END PUBLIC KEY-----`;

export const PRODUCTION_PUBLIC_KEYS: readonly KeyObject[] = [createPublicKey(KEY_1)];
