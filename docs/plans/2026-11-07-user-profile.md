# User profile — implementation plan

Spec: `docs/specs/2026-11-07-user-profile-design.md` · Branch: `feat/user-profile` · One implementation PR, one
commit per task after `WIREBENCH_SKIP_PERF=1 pnpm check` is green; `pnpm test:perf` before each push.

## Rulings on gaps in the spec

1. **Image version** is the first 16 hex characters of the sha256 of the stored bytes.
2. **WebP check on the server** reads the RIFF/WEBP header, walks the chunks, takes the dimensions from `VP8 `,
   `VP8L` or `VP8X`, and refuses `EXIF`, `XMP `, `ICCP` and `ANIM` (spec §9): a small pure parser in
   `identity/webp.ts`, unit tested with hand-made headers; no image library.
3. **"Shares a team"** for `GET /users/:id/profile` is one `exists` over `team_members` joined on itself; a server
   admin, or the caller themself, always passes; anyone else gets 404.
4. **Username rules live in `@wirebench/engine`** (`usernameSchema`, `RESERVED_USERNAMES`, `MAX_ABOUT_LENGTH = 500`);
   the renderer restates the pattern and limits (it may not value-import the engine) with a pinning test, as
   `MAX_DISPLAY_NAME_LENGTH` is today.
5. **`PATCH /me` with `username` equal to the current one** (case-insensitively) writes nothing; one PATCH may
   change several fields and records one `user.updated` with all their names.
6. **Image cache in the renderer** is a module-level `Map` keyed `url|userId|kind|version` holding the `data:` URL
   promise; failed loads are not cached.
7. **Crop maths** is one pure function `cropRect(image, frame, zoom, offset) → {sx, sy, sw, sh}` in
   `features/preferences/user/crop.ts`; the dialog only draws.
8. **Sign-in body:** `localSignInRequestSchema` becomes `{ identifier } | { email }` plus `password` and `device`
   (exactly one of the two); the browser form posts `identifier` and the server also reads `email` from older
   pages cached in a browser.
9. **The People row opens the card** from the avatar and the name, both buttons; the card loads with
   `account.person` and shows "This person is no longer on your teams." on 404.
10. **The Team dialog's members tab** (desktop fallback) gets the avatar only, not the card.
11. **Equal timing:** `checkLocalCredentials` verifies against a module-level dummy hash (made once at start with
    the same parameters as real hashes) when no account matches (spec §9).
12. **Per-user profile limiter:** a `TenantRateLimiter` named `profile`, keyed by user id, two buckets (changes
    30/min, uploads 20/h), in `identity/module.ts` beside the identity limiter.
13. **About cleaning:** trim, then drop characters in `\p{Cc}` other than `\n` (and `\r\n` → `\n`), then the
    length check, in one `cleanAbout` used by the route; the schema checks length after cleaning.

## Tasks

### 1. Shared schemas (`packages/core/src/server-api/identity.ts`, `teams.ts`, `audit.ts`)

- `usernameSchema`, `RESERVED_USERNAMES`, `aboutSchema`, `MAX_ABOUT_LENGTH`, `imageRefSchema = { version }`,
  `imageKindSchema = 'photo' | 'cover'`, `IMAGE_LIMITS` (dimensions and byte caps per kind).
- `serverUserSchema` gains `username`, `about`, `photo`, `cover`; `meUpdateRequestSchema` takes optional `name`,
  `username` (string or null), `about`, refusing an empty object; `imageUploadRequestSchema`;
  `userProfileSchema`; `localSignInRequestSchema` per ruling 8.
- `teamMemberSchema` and `userSummarySchema` gain `username` and `photo`.
- Tests: schema accept/refuse tables (reserved names, `@`, non-ASCII look-alikes, length, case).

### 2. Migration (`packages/server/migrations/identity/0026_user-profile.sql`)

- Columns, unique key `users_username_lower_key`, the lower-case check, `user_images` with RLS as `users`.
- `src/db/errors.ts` maps `users_username_lower_key` to `identity-username-taken`.
- Tests: `test/integration/identity/migration.test.ts` (columns, keys, policy), catalog helpers.

### 3. Repo (`packages/server/src/identity/repo.ts`)

- `UserRow` gains `username`, `about`, `photo`, `cover` (versions via a left join on `user_images`).
- `findUserByUsername`, `setProfile(tx, id, {displayName?, username?, about?})`, `putImage`, `deleteImage`,
  `getImage`, `sharesTeam(tx, a, b)`.
- `teams/repo.ts` `MEMBER_SELECT` and the user directory query add `username` and the photo version.
- Tests: integration for uniqueness per tenant (two tenants share a username), cascade on user delete, RLS keeps
  another tenant's images out.

### 4. Profile and image routes (`identity/routes/me.ts`, new `identity/routes/profiles.ts`, `identity/webp.ts`)

- `PATCH /me` per rulings 5 and 13; problems `identity-username-invalid`, `-taken`, `identity-about-invalid`.
- `PUT|DELETE /me/images/:kind` (route body limit 3 MB; strict base64 decode; WebP check per ruling 2; size cap →
  `identity-image-too-large`; anything else → `identity-image-invalid`).
- `GET /users/:id/images/:kind` with the spec §9 headers and 304 on `If-None-Match`; `GET /users/:id/profile`
  (ruling 3).
- The profile limiter (ruling 12) on `PATCH /me` and image writes.
- Audit `user.updated` with the changed field names only.
- Tests: unit for `webp.ts` (metadata, animation, wrong size, truncated, non-RIFF); integration for every route,
  headers, rights across tenants and teams (404 for strangers), limiter, audit details.

### 5. Username sign-in (`routes/auth-local.ts`, `routes/browser-sign-in.ts`, `sign-in-page.ts`, `rate-limit.ts`)

- `checkLocalCredentials(identifier)`: `@` → email, else username; dummy-hash verify on a miss (ruling 11).
- Message "The email, username or password is not right."; browser page field "Email or username",
  `type="text"`, `name="identifier"`, value escaped.
- `identifierKey` replaces `emailKey` (reads `identifier` or `email`, lower-cased).
- Tests: sign-in by each, both fields refused, rate limit by username, a miss still runs the hash, the page markup.

### 6. Export (operations slice)

- User rows carry `username` and `about`; `users/<id>/photo.webp` and `cover.webp` written when set.
- Tests: the export test's expected file list and row shape.

### 7. Wire and host (`packages/wire`, `packages/host`)

- Wire schemas mirror task 1; `AccountWire` gains `username` and `photo`; channels `account.image`,
  `account.setImage`, `account.removeImage`, `account.person`; `account.updateProfile` takes `username`, `about`.
- `server-client.ts`: `updateMe(url, token, patch)`, `putImage`, `deleteImage`, `image` (bytes → `data:` URL, only
  `image/webp` accepted back), `profile`. `AccountService` stores `username` and `photo` beside the display name.
- Sign-in sends `identifier`. `apps/desktop/test/fixtures/ipc-names.json` updated.
- Tests: host handler tests with the fake server; `e2e/helpers/fake-server.ts` learns the new routes.

### 8. Avatar plumbing (renderer)

- `state/person-images.ts` (ruling 6) and `components/person-avatar.tsx` (`{ url, userId, name, photo, size }` →
  image or initials; the `img` carries `alt=""` beside the visible name).
- Account menu (`features/account/account-status-item.tsx`) uses it.
- Tests: initials fallback, one fetch per version, refetch on a new version.

### 9. Crop dialog (`features/preferences/user/crop.ts`, `crop-dialog.tsx`)

- File pick (20 MB cap before decode), decode via `createImageBitmap`, drag and zoom, canvas encode to WebP (no
  metadata is carried by a canvas), error line.
- Tests: `cropRect` table (fit, zoom, clamped drag); dialog renders and cancels; an oversize file is refused.

### 10. Profile page (`features/preferences/user/profile-page.tsx`, `state/user-settings.ts`)

- Cover band, photo, *Change…*/*Remove*, name, `@username` field, about textarea with counter, email, methods.
- Store gains `setUsername`, `setAbout`, `setImage`, `removeImage`, with per-field errors.
- Tests: each save, server errors kept under their field, counter, remove.

### 11. People rows and profile card (`features/team/settings/people-page.tsx`, new `profile-card.tsx`)

- Avatar via `PersonAvatar`, `@username` in the second line, avatar and name open the card (ruling 9).
- Team dialog members tab gets the avatar (ruling 10).
- Tests: row content, card loads and shows fields (about as text, a `<b>` stays literal), 404 message.

### 12. Desktop sign-in dialog

- Label "Email or username", `type="text"`; validation accepts a username.
- Tests: the dialog test's label and submit body.

### 13. Docs and changelog

- `docs-site` guides: User settings → Profile, signing in with a username, the profile card, what the server
  refuses in an image and why.
- `CHANGELOG.md` [Unreleased] Added entry.

### 14. e2e (browser suite)

- `e2e/browser/profile.spec.ts`: set a username, sign out, sign in with it; upload a small generated image as
  the photo and see it in the account menu and on People; open the seeded team mate's card.

### 15. Gate and PR

- Full gate, `pnpm test:perf`, rebuild the local server and check by hand, open the PR with Auto-fix on.
