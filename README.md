# Swarm Image Gen (SillyTavern extension)

Generates images with a local [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) server and posts them
into the SillyTavern chat. Built as a replacement for the built-in "Image Generation" (Stable Diffusion)
extension, with the two things that one lacks:

* **full LoRA support** — LoRAs are sent as native `<lora:name:weight>` tags (SwarmUI parses them itself), and
  you can stack as many as you want with individual weights. Active LoRAs stay authoritative: if you rewrite the
  prompt in the *Edit prompts before generation* popup, their tags are appended again, and SwarmUI's own warnings
  (a LoRA name it does not know) are shown as a toast instead of being swallowed.
* **per-character look tags** — a fixed list of appearance/face/hair/outfit tags per character, always
  prepended to every prompt, so the character keeps her face and clothes between images,
* **one obvious image button** — an entry in SillyTavern's own wand menu (the one with *Attach a File*), plus a
  wand button under every message. SillyTavern's built-in image button keeps working next to them; a checkbox in
  the panel hides it if you would rather see only SwarmUI's button.

It also supports letting the chat model write the image prompt from the current scene, an optional popup to
review and edit every prompt before it is sent (*Edit prompts before generation*), interactive mode
(auto-generate when you ask for a picture in chat), a function tool so tool-capable models can request images
themselves, keeps a busy-lock so two generations can never overlap, and saves every picture into SillyTavern's
own user images folder.

---

## Install

Needs SillyTavern **1.12.0 or newer** and a [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) server.
No npm install, no build step, no restart.

### A. Let SillyTavern clone it (recommended)

*Extensions* → **Install extension** → paste the repository URL:

```
https://github.com/aternos564/swarm-image-gen
```

leave *Branch or tag name* empty, press **Install just for me**, then reload the page (F5).
To pull updates later: *Extensions → Manage extensions → Update all* (you also get a toast when a new
version is pushed, because the manifest enables `auto_update`).

> The folder name does not matter: the extension loads its settings panel from its own directory, so a renamed
> repo, a folder copied by hand or an unzipped `swarm-image-gen-main` all work.

### B. Copy the folder (no git, works offline)

Copy the whole `swarm-image-gen` folder into your **user extensions** directory:

```
<SillyTavern>/data/<your-user>/extensions/swarm-image-gen
```

e.g. `SillyTavern/data/default-user/extensions/swarm-image-gen`, so that the folder contains
`manifest.json`, `index.js`, `style.css`, `settings.html`. Reload SillyTavern (F5) afterwards.

### Android / Termux

Option A works exactly the same from the phone's browser. Two things to remember there:

* **SwarmUI base URL** — use your PC's LAN address (e.g. `http://192.168.1.6:7801`), never `127.0.0.1`.
  On the phone, `127.0.0.1` is the phone itself.
* **CORS** — the phone's origin can never match SwarmUI's single `AccessControlAllowOrigin` value, so enable
  SillyTavern's own proxy on the Termux install: `enableCorsProxy: true` in `config.yaml`, then restart it.
  The extension's *Auto* transport then falls back to `/proxy/` on its own.

---

## Setup (once)

1. Open the **Extensions** drawer and expand **Swarm Image Gen**.
2. **SwarmUI base URL** — `http://127.0.0.1:7801` by default. Change the port if your SwarmUI runs elsewhere.
3. Press **Connect**. The status line should turn green and list your checkpoints and LoRAs:

   `Connected. 9 checkpoint(s), 11 LoRA(s), 45 sampler(s) — via SillyTavern proxy`

4. Pick a **checkpoint**, and optionally a VAE, sampler and scheduler. Sizes, steps, CFG and seed are all
   under *Sampling*. For SDXL anime checkpoints, `832x1216`, 25 steps, CFG 6, `euler_ancestral` + `normal` is
   a good starting point.
5. **Prefix tags / Suffix tags / Negative prompt** — your usual quality tags. Prefix tags go in before the
   scene, suffix tags after it.
6. **LoRAs** — choosing one in the dropdown activates it right away: it appears as a chip and its
   `<lora:name:weight>` tag is appended to every prompt. Active LoRAs are ticked with `✓` in the dropdown.
   Typing in the weight box updates the chip live; click the `✕` on a chip to remove it. (`+ Add` just
   re-applies the current weight, and you can stack several LoRAs.)
7. **Character look tags** — with a character open, fill in e.g.
   `1girl, long black hair, brown eyes, red kimono, tall`. Saved on the character card itself
   (`data.extensions.swarm_look_tags`) and always prepended to prompts for that character.
   In group chats the tags of the character who wrote the message are used automatically.
8. *(optional)* Tick **Let the chat LLM write the scene prompt** and edit the instruction to taste.

## Usage

| Trigger | What it does |
| --- | --- |
| **Generate Image (SwarmUI)** in the wand menu next to the chat box | Generates from the current chat: the last message, or an LLM-written scene when that option is on. |
| Blue wand button in a message's extra buttons | Generates an image for that message. With the LLM option on, the model rewrites the scene into image tags; otherwise the message text is used. |
| `/swarm a girl on a throne` | Uses the given text as the scene prompt. |
| `/swarm` (no text) | Always asks the chat model to write the scene prompt. |
| **Generate now** button in the panel | Same as `/swarm` with no text. |
| `send me a picture of a cat` in chat (*Use interactive mode* on) | Generates automatically, using the detected subject as the scene. |
| Chat model calling the `GenerateImageSwarmUI` function tool (*Use function tool* on) | Tool-capable models request the image themselves during the scene. |
| *Edit prompts before generation* on | Every trigger above first opens a popup with the finished prompt (and negative prompt), both editable. Active LoRA tags are put back automatically if your edit removes them. |

Optional arguments: `/swarm quiet=true width=832 height=1216 steps=30 cfg=5 seed=1234 model=... sampler=... scheduler=... vae=... images=1`
(`quiet=true` generates without posting to chat).

Images are saved to `data/<user>/user/images/<character>/swarm_<character>_<date>.png` and posted as a
**system message**, which SillyTavern never sends to the language model — so your context stays clean.
SwarmUI keeps its own copy in its `Output/` folder; delete those from time to time if the disk matters.

---

## CORS and the request transport

A browser page is only allowed to call another host if that host says so (`Access-Control-Allow-Origin`).
SwarmUI is a different origin from SillyTavern, so by default the browser may refuse to talk to it.
The setting **Request transport** decides how requests travel:

| Mode | Behaviour |
| --- | --- |
| **Auto** (default) | Tries a direct browser → SwarmUI call first. If the browser blocks it, it falls back to SillyTavern's `/proxy/` route and remembers which one worked. |
| **Direct** | Browser → SwarmUI only. Needs SwarmUI to allow the SillyTavern origin. |
| **SillyTavern /proxy/ only** | Everything goes through SillyTavern's built-in CORS proxy. |

Fix it properly with **one** of these:

### 1. Let SwarmUI accept the SillyTavern origin (recommended, no SillyTavern changes)

In SwarmUI: *Server → Settings → Access Control Allow Origin*, or edit `SwarmUI/Data/Settings.fds`:

```json
"AccessControlAllowOrigin": "http://127.0.0.1:8001"
```

Restart SwarmUI. Use the exact origin you see in your browser's address bar (scheme + host + port) —
`http://localhost:8001` and `http://127.0.0.1:8001` are **different** origins. `*` also works but then any
website you visit could queue generations on your server, so the exact origin is better.
After this, transport `direct` (and `auto`) work.

### 2. Use SillyTavern's own CORS proxy

In `config.yaml`:

```yaml
enableCorsProxy: true
```

or start SillyTavern with `--corsProxy`. Then the proxy transport works. Nothing else on your server changes:
the route only forwards the request and strips the `Origin` header, so SwarmUI's CORS check never applies.
This must be enabled again after a config reset, and it is off by default.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Status: *"Could not reach SwarmUI. SillyTavern's CORS proxy is disabled…"* | Neither transport worked: SwarmUI is unreachable **or** the browser blocked it. Check that SwarmUI is running, then apply fix 1 or 2 above. |
| Status: *"Could not reach SwarmUI. SillyTavern's proxy could not connect…"* | The URL is wrong (bad port / SwarmUI not started). Test it by opening `http://127.0.0.1:7801` in a browser tab. |
| Status: *"…responded 500: Internal Server Error"* | Wrong port, or SwarmUI crashed on startup. Check SwarmUI's console. |
| Status: *"SwarmUI responded 400: Invalid session ID"* | The extension re-creates sessions automatically; if it persists, press **Connect** again. |
| Model dropdown is empty | Press **Connect**. If the list is still empty, SwarmUI sees no models — check its `Models/Stable-Diffusion` folder and refresh SwarmUI's model list. |
| *"Model 'X' is not on server"* | The saved checkpoint no longer exists on the SwarmUI side. Pick another one and press Connect. |
| LoRA has no effect | First check the **Active LoRAs** list under the LoRA row — the LoRA you pick in the dropdown is activated immediately and ticked with `✓` there. If the chip is there but the image ignores the LoRA, SwarmUI now says so in a toast (e.g. *"Lora 'x' does not exist and will be ignored"*) — that means the name is not in SwarmUI's list. Also check the LoRA's base model matches the checkpoint (SD1.5 LoRAs do nothing on an SDXL/Pony/Illustrious checkpoint). The weight lives in the chip — `0.8` is a sane start, `1.0+` is often too strong, and `0` disables the LoRA. |
| *"Invalid value for parameter VAE"* | You are sending a VAE name SwarmUI does not have. Set VAE back to *Automatic*, or pick a real VAE file from the dropdown. |
| The character's face keeps changing | Uncheck nothing — instead check the **look tags** are filled in for *that* character, and that the prompt is not dominated by scene tags. Also the seed: `-1` gives a new face every time. Fix a seed to compare. |
| Image is posted but shows as a broken picture | The file was saved but the chat message points elsewhere. Reload and check `data/<user>/user/images/`. |
| Nothing happens when I click the wand button | Open the browser console (F12) and look for `[swarm]` lines. If the button is missing entirely, the extension did not load — reload the page. If you clicked the *paintbrush* button, that was SillyTavern's built-in image extension, not this one. |
| Two generations at once | Not possible by design; the second one is refused with a toast. |

Console logging: everything is prefixed with `[swarm]`, including the exact request that was sent
(`model / sampler / width / height / steps / cfg / seed / prompt / negative`).

---

## Notes

* Tested against **SwarmUI 0.9.8.3** and **SillyTavern 1.18.0**.
* Core SillyTavern files are never modified, and `auto_update` is on (update from *Manage extensions*), so the
  extension survives SillyTavern updates. It only imports `saveBase64AsFile` from `scripts/utils.js` and takes
  everything else from `SillyTavern.getContext()`.
* SillyTavern's built-in *Image Generation* (Stable Diffusion) extension is a different extension with a fixed
  backend list (ComfyUI, Automatic1111, Extras, cloud APIs) that can never point at SwarmUI. Its button is left
  alone and stays visible; tick *Hide SillyTavern's built-in image buttons* in the panel if you want a single
  image button (a pure body-class/CSS toggle, nothing outside this folder is touched). SwarmUI also 404s on the
  A1111-compatible `/sdapi/v1/` paths, so pointing the built-in panel at it is not an option either.
* Prompts are cleaned up before being sent (newlines/quotes/markdown removed, extra commas collapsed,
  `<think>` blocks dropped). Non-Latin characters are stripped, because CLIP cannot read them anyway.
* Look tags, prefix/suffix tags and the negative prompt support SillyTavern macros (`{{char}}`, `{{user}}`, …).
