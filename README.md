# ChatGPT History Navigator

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A browser extension for browsing and navigating the complete history of ChatGPT conversations. It adds a timeline beside the conversation, making long chats easier to scan and revisit.

## Features

- Display the complete conversation history, including messages not yet loaded on the page.
- Preview the current prompt and assistant reply by hovering over or focusing a timeline item.
- Click a timeline item to jump to its message; older pages are loaded automatically when needed.

## Installation

### Requirements

- Node.js
- [pnpm](https://pnpm.io/)

### Build

Build the extension:

```sh
pnpm install
pnpm build

# Firefox
pnpm build:firefox
```

### Load the extension

#### Chromium-based browsers

Open the browser's extension management page, enable Developer mode, and load `.output/chrome-mv3`.

#### Firefox

Open `about:debugging` and load `.output/firefox-mv2/manifest.json`.

## How it works

### History loading and synchronization

When a conversation opens, the extension observes ChatGPT's history requests and parses the responses into a normalized message list. If a response is incomplete, it requests older pages through ChatGPT's own endpoints and merges them by cursor until the complete history is available. The result is kept in an in-memory cache.

For direct history loading, it tries ChatGPT's full-conversation endpoint first. If that endpoint is unsupported, it falls back to the paginated conversation endpoint and follows its cursors until all pages are merged.

The page-side script also observes conversation updates. New messages, edits, and regenerations are merged into the same cache, while switching conversations or accounts clears the previous data.

### Message navigation

When a timeline item is selected, the extension first uses ChatGPT's own navigation. If the target is not in the DOM, it asks ChatGPT's targeted history loader to fetch it, observes pagination and DOM updates, and waits for the message to render. If native reveal is unavailable, it falls back to finding the rendered message or placeholder in the DOM and scrolling to it. If targeted history loading is unavailable, the navigation reports an error instead of guessing.

## Privacy

This extension processes ChatGPT conversation data locally in your browser and only communicates with ChatGPT's own services as needed for its features. It does not send your conversations, personal data, or authentication information to the developer or third-party analytics or advertising services.

## License

GNU General Public License v3.0
