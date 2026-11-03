# Augur Chat

Augur Chat is a chat page for every chat model you have set up in Augur, on your own network or at a hosted provider. The service serves it at `/chat/` next to the [web app](web.md). The owner opens it with the web token and everyone else with a personal token, and every message goes through the same rules a job does.

## Opening it

The chat is part of the web app, so turn that on first, as [Turning it on](web.md#turning-it-on) describes. Then run `augur web` and add `chat/` to one of the links it prints, just before `#token=`. A link such as `http://127.0.0.1:7420/#token=...` becomes `http://127.0.0.1:7420/chat/#token=...`. A browser that has already opened the web app has the token saved and can go straight to `/chat/`, and a page opened without a token asks you to paste it.

Every route in `routes.json` on the `openai-api` or `anthropic-api` adapter shows up as a model, except routes whose `mode` is anything other than chat, such as `embeddings` or `transcribe`. That covers OpenAI-style and Anthropic-style APIs, local or hosted. With no such route, the page says so and has nothing to pick.

## Picking a model and a data level

The two chips under the message box show the model and the chat's data level. Click either one to change it. The model list starts with On your network, which holds models on this computer, at a private address such as `192.168.1.20` or `10.0.0.5`, or at a `.local` or `.lan` name. Hosted models come after them. Badges show which models can read images and, when it is known, how much text each one can hold at once.

Every chat has a data level: public, internal, sensitive, or regulated. Pick the level of the most sensitive thing you plan to put in the chat. The model list then greys out every model your rules in Augur do not clear for that level, and a model that is paused or blocked for another reason says why. A new chat starts at the level you used last, which is internal the first time.

A chat's level can go up at any time, but once the chat has messages it cannot come back down. The whole history goes to whichever model answers next, and a lower level would let a model cleared only for internal text read the sensitive things already in it. Augur checks each message against your rules as you send it, so a model you paused after the chat started cannot answer. You can switch models partway through a chat when the new one is cleared for the chat's level, and it gets the whole history.

## Saved and temporary chats

A new chat is saved when you send its first message, and it takes its name from the first few words of that message. The list groups saved chats under Today, Yesterday, Previous 7 days, and Earlier, with pinned chats above them all. The search box finds chats by words in any of their messages. Click the title at the top of the page to rename a chat, and use the buttons on a chat in the list to pin or delete it. Delete asks for a second click before it removes the chat.

A temporary chat lives in the service's memory only. Start one with the button beside New chat, or with New temporary chat in the command palette. It shows in the list with a ghost icon, nothing about it goes into the saved chats, and it is gone when you delete it or the service restarts. A banner above the messages shows when the open chat is temporary.

## Editing, writing again, and branches

The messages in a chat form a tree rather than a single line. Edit one of your messages and send it, and the chat branches at that point while the earlier version stays. Under each reply, Write this again asks the same model for a new reply, and Write this again with another model lets you pick a different one. Each new reply is another branch.

A message with more than one version shows a switcher such as `1/2`, and its arrows step from one version to the next. The chat then follows the branch you are on, and the next message you send continues it. Up on an empty message box opens your last message for editing.

## Attachments

Attach files with the paperclip button, by pasting them into the message box, or by dropping them anywhere on the page. A message can carry up to 8 files of up to 25 MB each.

Images show in the chat and go to the model with the message. The contents of a text file, such as a `.txt`, `.md`, `.csv`, `.json`, or source file, are added to the message the model gets. Audio files play in the chat, and other files show as a chip that downloads them, but neither is sent to the model. Pages such as PDFs and vector images such as SVGs are only ever offered as downloads and are never shown inside the chat.

When the model you have picked cannot read images, the chat warns you as soon as you attach one and will not send it. Pick a model with the image badge, or remove the image.

## Replies

A reply appears as the model writes it. Esc or the stop button ends it early, and the text that has arrived so far stays in the chat. When a model sends its reasoning, it shows in a block above the reply. The block reads Thinking... while the reasoning arrives, then gives the time it took, as in Thought for 12s. The block closes when the reply starts unless Show reasoning open is on, and a click opens it again.

Replies render Markdown: headings, lists, task boxes, tables, links, and code blocks with a Copy button. Each reply shows the tokens it read and wrote and, when the cost is known, what it cost.

## Model settings

Ctrl+, opens the settings drawer for the current chat. It holds a system prompt and the settings the picked model offers, such as temperature, top P, and the reply length limit, with the rarer ones under Advanced. A model served through Cogitator shows the settings Cogitator reports for it. The info button beside each setting explains what it changes and shows the model's own default.

The settings belong to the chat and are saved with it. Only the values you change are sent, so everything else stays at the model's default. Reset next to a setting clears that one, and Reset all clears the system prompt and every setting. If you switch a chat to a model that does not offer a setting you changed, that setting is not sent.

## Preferences

The sliders button at the foot of the chat list opens the preferences: the theme (follow the system, light, or dark), the text size, compact spacing, animations, and whether a model's reasoning shows open. They are kept in this browser.

A browser can also re-theme every color and size the chat uses. Store a JSON object of CSS token names and values in its local storage under `augur.chat.skin`, and the chat applies it over its own values when it loads. For example, run this in the browser's console and reload the page:

```js
localStorage.setItem('augur.chat.skin', JSON.stringify({ '--accent': '#b5480f', '--chat-user': '#fbeee4' }))
```

The token names are listed at the top of the chat's stylesheet, `chat.css`. Remove the key to go back to the defaults.

## Keys

Ctrl+K opens the command palette. Type to find a command, a saved chat, or a model, and press Enter to run it. Its commands start a new chat or a temporary one, open the model settings, show or hide the chat list, change the theme or the spacing, switch to any model, and open any recent chat.

| Key | What it does |
| --- | --- |
| Enter | Sends the message. On a touch screen, Enter starts a new line and the send button sends. |
| Shift+Enter | Starts a new line. |
| Esc | Stops the reply being written. |
| Up | On an empty message box, edits your last message. |
| Ctrl+K | Opens the command palette. |
| Ctrl+B | Shows or hides the chat list. |
| Ctrl+Shift+O | Starts a new chat. |
| Ctrl+, | Opens the model settings for this chat. |

On a Mac, Cmd works in place of Ctrl in each of these.

## Where chats are kept and who can read them

Saved chats live on the computer that runs the service, in its data folder: `%LOCALAPPDATA%\Augur\dispatch` on Windows and `~/.local/share/augur/dispatch` on macOS and Linux. The messages are in a SQLite database named `chat.db`, and attachments are in a `chat-files` folder next to it. Neither is encrypted, so any person or program that can read your files can read every saved chat. Deleting a chat in the page removes its messages and its attachments.

A temporary chat stays in memory and never goes into `chat.db` or `chat-files`. The one thing that touches the disk is a reply's own attachments: while a reply is being written, the images and text files it sends to the model sit in a `chat-tmp` folder in the data folder, and they are removed when the reply ends. That happens in temporary chats too.

The owner's web token reads the owner's chats and can do everything else the web app does. A user's personal token reads only that user's chats. Every chat and attachment is stored unencrypted on the host, so anyone who can read the service data folder can read all of them, the owner included. Keep tokens like passwords. Run `augur web rotate` if the web token gets out, and see [Tokens and devices](#tokens-and-devices) for a leaked user token or a lost device.

The service starts a separate process for each reply and hands the provider key only to that process, so the key never enters the service itself. The page's offline cache never keeps anything the service sends back, so chat text stays out of the browser's cache. If the service listens on a network address over plain http, the token and every message cross the network unencrypted, and [Plain http and https](web.md#plain-http-and-https) covers how to avoid that.

## Sharing the chat with other people

The owner can set up other people as users, each with their own chats, models, and sign-in. Once users exist, the reading rules in [Where chats are kept and who can read them](#where-chats-are-kept-and-who-can-read-them) apply to each person separately. To reach the chat from other machines without opening the rest of the web app, set up [the chat listener](web.md#the-chat-listener).

### Users

A user has an id, a name, an optional email, a list of allowed chat models, a data-tier cap, an optional daily message limit, and an enabled flag. The id is a lowercase slug of up to 32 characters made of letters, digits, and hyphens. [Cloudflare Access](web.md#signing-in-with-cloudflare-access) sign-in matches people by this email.

A new user has no models until the owner lists some, and sees a message telling them to ask the owner. The list can only narrow what the rules already allow for chat. It never adds a model the rules refuse.

The tier cap is `public`, `internal`, `sensitive`, or `regulated`, and new users start at `internal`. A user cannot create a chat above their cap or move one above it, and the tier chips in the page do not offer the higher levels. The daily limit counts the user's own messages since local midnight. Once the limit is reached, the next send is refused with a plain message. A disabled user is refused.

### Tokens and devices

Each user has one user token, and each of their devices has its own device token. A device belongs to one user and has a label. Both kinds of token start with `augc_`, appear once when made, and are stored only as a hash.

Rotating a user token ends the old one. Revoking a device ends that device's token and nothing else, and the service keeps its last-seen time.

A user or device token works only for `/chat/` and `/api/chat/`. On every other path the service treats it as a wrong token and counts it toward the same lockout. The owner's web token keeps full access.

### Who sees which chats

Every saved or temporary chat, every message, and every attachment belongs to one person. Another person's chat answers as missing. In the page, the owner sees only the owner's chats. Chats that existed before users were set up stay the owner's.

Deleting a user keeps their chats stored but unreachable. To delete the chats and their files too, purge them with `--purge` or the checkbox in the admin panel.

User credentials live in `chat-users.db` in the service data folder, as hashes only. Chats stay in `chat.db`.

### Managing users from the command line

The `augur web user` and `augur web device` commands work on the files directly, so they run whether the service is up or stopped. Adding a user, adding a device, and rotating a token print the new token once.

```
augur web user add <id> --name <name> [--email <e>] [--models a,b,c] [--tier <tier>] [--daily <n>]
augur web user list
augur web user set <id> [--name --email --models --tier --daily --enable --disable]
augur web user remove <id> [--purge]
augur web user token <id>
augur web device add <user> <label>
augur web device list [<user>]
augur web device revoke <user> <device-id>
```

### Managing users from the chat page

The owner opens the admin panel with "Manage users" in the command palette or with the button next to the signed-in label. The panel is available only to the owner on the main listener.

Each user has a card with their email, enabled switch, tier cap, daily limit, and model checklist. A model the rules refuse appears disabled with the reason. The card lists the user's devices with a Revoke button and has Add device, New token, and Delete user buttons. Delete user has a checkbox to delete the user's chats as well. An Add user form sits below the cards. A new token appears once with a Copy button.

### Admin API

The admin API is served on the main listener and accepts only the owner's web token. Paths are under `/api/admin/chat`.

- `GET /users` lists users, and `POST /users` adds one.
- `PATCH /users/<id>` changes a user, and `DELETE /users/<id>` removes one. Add `?purge=1` to delete their chats and files too.
- `POST /users/<id>/token` rotates the user token.
- `POST /users/<id>/devices` adds a device.
- `DELETE /users/<id>/devices/<device-id>` revokes a device.
- `GET /routes` lists the chat routes for the model checklist.

`GET /api/chat/me` tells the page who is signed in.

### Signing in

When the browser has no stored token, the page first asks `/api/chat/me`. A [Cloudflare Access](web.md#signing-in-with-cloudflare-access) identity or a working token opens the chat. Otherwise the page asks for a token: the owner's web token or the personal token the owner handed out.

The label at the foot of the chat list shows the person's name, or Owner, with a Sign out button. Access sign-ins have no Sign out button. When the server refuses a send, for example over the daily limit or a model the user may not use, the page shows the server's sentence in a toast.

### What sharing does not change

Plain http on a network sends tokens in the clear, so keep https, the default on a network bind. A cloud model a user is allowed to use receives that user's messages, subject to the data tier rules.

## On a phone

Open the chat link in the phone's browser, the same way as on a computer. Then use the browser's Add to Home Screen or Install app command. The chat gets its own icon, named Augur Chat, and opens full screen without the browser's address bar. On a phone, the chat list slides in from the side, and the send button sends, since Enter starts a new line.
