# User profile: photo, cover, username and about — design

Date: 2026-11-07 · Status: owner decisions 1–5 below are final · Builds on:
`docs/specs/2026-11-07-settings-split-design.md` §4 (User settings → Profile) · Plan: to follow

## 1. Owner decisions

1. **Profile photo and cover image.** Each person on a server has an optional profile photo and an optional cover
   image, set on User settings → Profile.
2. **Username.** Each person may set a username, unique on the server. It is shown as `@username` and **signs in
   in place of the email** with a password.
3. **About.** A short "Tell people more about you" text.
4. **Shown everywhere a person is:** the photo in the account menu at the top right and on People rows; a profile
   card any team mate can open from People (cover, photo, name, @username, about); edited on Profile only.
5. **Images are cropped and resized in the app** before upload: the photo square, the cover 3:1. The server
   stores them in its database.

## 2. What a profile holds

| Field | Rules | Default |
| --- | --- | --- |
| Name | as today: 1–120 characters, trimmed | as today |
| Username | 3–30 characters from `a–z 0–9 . _ -`, starting with a letter or digit; typed in any case, stored lower-case; unique per server (per tenant in the hosted edition); never contains `@`, so it cannot be mistaken for an email; a short reserved list (`admin`, `administrator`, `root`, `system`, `support`, `wirebench`, `me`, `api`) is refused | none: set by the person |
| About | 0–500 characters, plain text, line breaks kept; shown as text, never as HTML or Markdown | empty |
| Photo | WebP, 256 × 256, at most 512 KB | none: initials are shown |
| Cover | WebP, 1500 × 500, at most 2 MB | none: a plain band in the accent tint |

- A username can be changed at any time; the old one is free for anyone at once. Clearing it is allowed (sign-in by
  email still works).
- People created by SCIM, SAML, OIDC, invitations and hosted signup get no username; they set one themselves.
  SCIM's `userName` stays the email (saml-scim spec), and nothing maps an IdP claim to the username.

## 3. Profile page (User settings → Profile)

From top to bottom, in one card like the other User settings pages:

1. **Cover band** (3:1, full card width) with the **photo** (96 px circle) overlapping its lower left edge.
   *Change cover…* sits on the band's top right; *Change photo…* under the photo. Each has *Remove* once set.
2. **Name**, saved on Enter or leaving the field (as today).
3. **Username**: an input with a fixed `@` prefix and the hint "Sign in with this or your email." Saved like the
   name. A taken or invalid name shows the server's message under the field and keeps the draft.
4. **About you**: a 4-line textarea, placeholder "Tell people more about you…", a `n / 500` counter, saved on
   leaving the field.
5. **Email**: read-only, as today. **How you sign in**: as today.

**Choosing an image** opens the system file picker (PNG, JPEG, WebP, GIF first frame; up to 20 MB before
processing), then a **crop dialog**: the image under a fixed frame (circle for the photo, 3:1 for the cover), drag
to move, a zoom slider (1×–4×), *Save* and *Cancel*. *Save* draws the frame to a canvas at the target size, encodes
WebP (quality 0.85), and uploads. A file the browser cannot decode shows "This file is not an image Wirebench can
read." in the dialog.

## 4. Where profiles show

- **Account menu (top right):** the trigger's avatar and the menu header show the photo when set, else the initial
  (today's).
- **People rows (Team settings):** the photo when set, else initials; `@username` after the email in the second
  line when set. Clicking the avatar or the name opens the **profile card**.
- **Profile card:** a dialog (420 px wide): the cover band, the photo, name, `@username`, the about text, the email,
  and the person's role in this team. *Close* or Escape closes it. Opened from People only in this slice.
- Desktop: the same avatar component is used wherever the renderer shows these people (account menu, the Team
  dialog's members tab), so the desktop shows photos too.

## 5. Signing in with a username

- **Password sign-in only.** The desktop's sign-in dialog and the browser sign-in page label the field
  "Email or username"; the input becomes `type="text"`, `autocomplete="username"`.
- Server rule: an identifier containing `@` is an email (today's lookup); anything else is looked up as a username
  (lower-cased). Unknown identifier and wrong password keep one answer: "The email, username or password is not
  right." (`identity-invalid-credentials`).
- The request body gains `identifier`; `email` stays accepted for desktops older than this change. Sending both
  is refused (400).
- The identity rate limiter's per-account key reads the identifier lower-cased (email or username), so ten tries a
  minute holds whichever is typed.
- SSO (OIDC, SAML) and password reset are unchanged; reset still asks for the email.

## 6. Server

### 6.1 Data

Migration `identity/0026_user-profile.sql`:

- `users` gains `username text null`, `username_lower text null`, `about text not null default ''`.
  `users_username_lower_key unique (tenant_id, username_lower)`; a check that `username_lower = lower(username)`.
- New table `user_images (tenant_id, user_id, kind, content_type, data bytea, sha256 text, updated_at)`,
  primary key `(user_id, kind)`, `kind in ('photo','cover')`, foreign key to `users` with `on delete cascade`,
  `tenant_id` and its row-level security policy as for `users`.

### 6.2 API (all under `/api/v1`, signed in)

| Method and path | Body / answer |
| --- | --- |
| `GET /me`, `PATCH /me` | `user` gains `username` (string or null), `about`, `photo` and `cover` (each `{ version }` or null; `version` is the image's sha256 prefix). `PATCH` takes any of `name`, `username` (string or null to clear), `about`. |
| `PUT /me/images/:kind` | JSON `{ contentType: 'image/webp', data: base64 }`. Checks the WebP header, the dimensions in it (256² or 1500 × 500) and the size limit; answers the new `{ version }`. Route body limit 3 MB. |
| `DELETE /me/images/:kind` | 204. |
| `GET /users/:id/images/:kind` | The image bytes with its content type, `ETag: "<sha256>"`, `Cache-Control: private, max-age=86400` (the version in the URL busts it), `X-Content-Type-Options: nosniff`. Anyone signed in on the same server (tenant) may read; 404 when unset. |
| `GET /users/:id/profile` | `{ id, displayName, username, about, photo, cover }` for someone who shares a team with the caller, or for a server admin; else 404. |
| `POST /auth/local/sign-in`, `POST /sign-in/local` | accept `identifier` (§5). |

- Team member and user summary answers gain `username` and `photo` (`{ version }` or null).
- New problems: `identity-username-invalid` (400), `identity-username-taken` (409), `identity-about-invalid` (400),
  `identity-image-invalid` (400), `identity-image-too-large` (413). The unique-key name maps to the taken problem.
- Audit: `user.updated` with `details.fields` naming what changed: any of `displayName`, `username`, `about`,
  `photo`, `cover` (names only, never values), `via: 'self'`.

### 6.3 Export

The team export (operations slice) includes `username` and `about` with the user rows and the images as files
(`users/<id>/photo.webp`, `cover.webp`).

## 7. Client plumbing

- The renderer never loads a server URL directly: the desktop CSP (`img-src 'self' data:`) stays. A new channel
  `account.image { url, userId, kind, version }` answers a `data:` URL; the host fetches it with the account's
  token. The renderer caches answers by `url + userId + kind + version` for the session, so a changed version
  refetches and an unchanged one never does. The browser client uses the same channel.
- New channels: `account.setImage { url, kind, data }`, `account.removeImage { url, kind }`, `account.person
  { url, userId }`. `account.updateProfile` gains optional `username` and `about`. `AccountWire` gains `username`
  and `photo` so the account menu needs no extra call.
- The sign-in dialog sends `identifier`.

## 8. Rulings

1. **Images in Postgres, not on disk:** one backup holds everything, RLS covers them, and they are small after the
   in-app resize.
2. **WebP only on upload:** the app always re-encodes, so the server checks one format.
3. **No public profile URL:** images and profiles need a signed-in caller of the same server.
4. **Username is opt-in;** no generated usernames for existing people.
5. **A server admin cannot edit someone else's profile** in this slice (only their name, as today, through SCIM).
6. **Mentions, search by username and a profile page of one's own outside settings** are not in this slice.

## 9. Testing

- Server unit and integration: username rules and uniqueness per tenant (two tenants may share a username),
  sign-in by username and by email, both fields refused, rate limit keyed by identifier, image header and size
  checks, image read rights across tenants and teams, profile read rights, audit field lists, migration catalog
  (columns, keys, RLS policy).
- Renderer: Profile page (save, errors, counter), crop dialog maths (frame to canvas rectangle) as a pure function,
  avatar fallback to initials, profile card, People row `@username`.
- e2e (browser): set a username, sign out, sign in with it; upload a photo and see it in the account menu and on
  People; open a team mate's card.
