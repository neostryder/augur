# Augur Chat

Augur Chat is a chat page for every chat model you have set up in Augur, whether it runs on your own network or at a hosted provider. The service serves it at `/chat/` next to the [web app](web.md), it opens with the same web token, and every message you send goes through the same rules a job does.

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

Whoever holds the web token can read every saved chat, and can do everything else the web app does. Keep the token like a password, and run `augur web rotate` if it gets out.

The service starts a separate process for each reply and hands the provider key only to that process, so the key never enters the service itself. The page's offline cache never keeps anything the service sends back, so chat text stays out of the browser's cache. If the service listens on a network address over plain http, the token and every message cross the network unencrypted, and [Plain http and https](web.md#plain-http-and-https) covers how to avoid that.

## On a phone

Open the chat link in the phone's browser, the same way as on a computer. Then use the browser's Add to Home Screen or Install app command. The chat gets its own icon, named Augur Chat, and opens full screen without the browser's address bar. On a phone, the chat list slides in from the side, and the send button sends, since Enter starts a new line.
