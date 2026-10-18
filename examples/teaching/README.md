# Teaching sample: a REST API in one hour

A small Wirebench project for a first lesson on HTTP APIs. It talks to
[JSONPlaceholder](https://jsonplaceholder.typicode.com), a free public practice API with users, posts
and comments. It needs no account and no key. It accepts writes and answers as if it saved them, but
it never stores anything, so a class of thirty can all "create" and "delete" at once without stepping
on each other.

The instructor notes and a three-session lesson plan are on the docs page
[Teach APIs with Wirebench](https://wirebench.github.io/wirebench/docs/guides/teaching/).

## What is in the project

| Item                                     | What it teaches                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| **Course** environment                   | `baseUrl` and `userId`, used by the requests as `${baseUrl}` and `${userId}`            |
| Users → **List users**                   | A plain `GET` that returns a JSON array                                                 |
| Users → **Get a user**                   | A path parameter, `/users/{userId}`                                                     |
| Posts → **Posts by a user**              | A query parameter, `?userId=…`                                                          |
| Posts → **Get a post**                   | An assertion on a value in the body: `$.id` equals `1`                                  |
| Posts → **Create a post**                | A `POST` with a JSON body, answered with `201 Created`                                  |
| Posts → **Delete a post**                | A `DELETE`                                                                              |
| Posts → **Get a missing post**           | A negative test: `404` is the right answer, and the assertion expects it                |
| Sequence steps → **Comments on a post**  | A request that reads a value from an earlier step, so it only works inside the sequence |
| **First post and its comments** sequence | Two steps: the first lifts a post id out of its response, the second sends it           |

Every request carries assertions, so each send tells you whether the response was right, not only
whether one came back.

## Before you start (5 minutes)

1. Install Wirebench from the
   [latest release](https://github.com/wirebench/wirebench/releases/latest). It is free and asks for
   no account.
2. Get this folder. Either download the repository as a ZIP from
   [GitHub](https://github.com/wirebench/wirebench) and unpack it, or clone it:

   ```bash
   git clone --depth 1 https://github.com/wirebench/wirebench.git
   ```

   The project is the `examples/teaching` folder.

3. Start Wirebench. On the workspace picker choose **Add project folder…** and pick the
   `examples/teaching` folder. Wirebench copies it into a new workspace, so the original stays
   untouched and you can always start again.
4. Open the environment switcher in the title bar and choose **Course**.

## Part 1: send your first requests (15 minutes)

1. In the explorer, expand **Practice API → Users** and open **List users**. Choose **Send**, or press
   <kbd>⌘⏎</kbd> on macOS and <kbd>Ctrl+Enter</kbd> on Windows and Linux.
2. Read the response pane: the status `200`, how long it took, and the body, a JSON array of ten users.
   Find the response's headers and look for `Content-Type`.
3. Open **Get a user**. The URL is `/users/{userId}`. On the **Params** tab, the path parameter `userId`
   has the value `${userId}`, which comes from the environment. Send it.
4. Open **Posts by a user**. This time `userId` is a query parameter. Send it, then compare the URL in
   the **HTTP Log** at the bottom with the one in the request.
5. Open **Create a post**. Look at the **Body** tab, then send it. The status is `201`, and the body
   echoes your post with a new `id`.
6. Change the `title` in the body to your own name and send it again.

**Check yourself.** What is the difference between a path parameter and a query parameter? Which
method did **Create a post** use, and why does its status differ from the others?

## Part 2: assertions (15 minutes)

1. Open **Get a post** and choose its **Assertions** tab. It has two: the status equals `200`, and the
   JSONPath `$.id` equals `1`.
2. Send it. The response pane's **Assertions** tab shows both passing.
3. Change the path parameter `postId` from `1` to `2` and send again. The status assertion still
   passes, but `$.id` equals `1` fails. Read the failure message, then put the `1` back.
4. Open **Get a missing post**. Its only assertion expects `404`. Send it: the server says "not found",
   and the test passes, because a missing post should be a 404.
5. Add an assertion of your own to **List users**: a JSONPath match that `$[0].name` is present.

**Check yourself.** Why is a test that expects a `404` as useful as one that expects a `200`?

## Part 3: environments (10 minutes)

1. Open the **Environments** view and select **Course**. It holds `baseUrl` and `userId`.
2. Change `userId` to `3`. Send **Get a user** and **Posts by a user** again: both now answer for user
   3, and you did not touch either request.
3. Choose **Add environment**, name it `Second user`, and give it the same `baseUrl` with `userId` set
   to `5`. Switch to it in the title bar and send the same requests.

**Check yourself.** Where would a real team keep a production URL, and why not in the request itself?

## Part 4: a sequence (10 minutes)

1. Under **Sequences**, open **First post and its comments**.
2. Select the first step, **Find the user's posts**. Its transfer named `postId` takes `$[0].id` from
   the response: the id of the user's first post.
3. Select the second step. Its request, **Comments on a post**, asks for
   `/comments?postId=${#Sequence#postId}`. The step checks that the first comment has an email
   address, which only holds when a real post id arrived.
4. Choose **Run**. Both steps pass. Open each step's result to see the value carried across.
5. Try sending **Comments on a post** on its own. Outside the sequence nothing sets
   `${#Sequence#postId}`, which is why it lives in a folder of its own.

**Check yourself.** Name a real-world pair of requests where the second needs a value from the first.

## Part 5: the same checks from a terminal (5 minutes)

The command-line runner sends the same requests with the same assertions, so a pipeline or an
instructor can check a project without opening the app. With [Node.js](https://nodejs.org) 24 or
later, from the folder that holds `examples`:

```bash
npx --yes @wirebench/cli run examples/teaching -e Course "apis/Practice API/requests/Users" "apis/Practice API/requests/Posts"
```

```bash
npx --yes @wirebench/cli run examples/teaching -e Course --sequence "First post and its comments"
```

Each request prints one line with a tick or a cross, and the command exits with `0` only when every
assertion passed. Point it at your own copy of the project to see your changes from Parts 2 and 3.

## If something does not work

- **Every request fails to connect.** The lab network may block outside sites or need a proxy. Set the
  proxy under **Settings → Proxy**, or ask your instructor.
- **`${userId}` shows as unresolved.** No environment is active. Choose **Course** in the title bar.
- **Comments on a post fails with an unresolved property.** Run it through the sequence, as in Part 4.
