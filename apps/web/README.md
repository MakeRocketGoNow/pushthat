## Push notifications: Web vs Chrome Extension

- **Web (Service Worker + FCM)**
  - Supported on Chrome, Edge, Firefox, and Android browsers.
  - Requires a registered service worker, Notifications permission, FCM Web SDK with VAPID key.
  - Receive pushes in `push` and show a notification; navigate in `notificationclick` via `clients.openWindow(...)`.

- **Limitations on the open web**
  - **iOS Safari** does not support FCM Web (relies on APNs; FCM tokens generally won’t work).
  - **No tab/window open in `push`**; you must wait for a user click (`notificationclick`).
  - **Permission UX & lifecycle** constraints: prompts usually need a user gesture; delivery depends on the browser being active in the background.

- **Why a Chrome Extension**
  - Background service worker registers with FCM and can react immediately to pushes.
  - Can open tabs programmatically using `chrome.tabs.create` for a smoother “receive-and-open” flow.
  - More reliable cross-desktop behavior without requiring a site tab to be open.

- **Current project behavior**
  - Push handling is implemented in the Chrome extension’s background service worker.
  - The web app does not currently register a service worker for FCM.

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default tseslint.config({
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```

- Replace `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked` or `tseslint.configs.strictTypeChecked`
- Optionally add `...tseslint.configs.stylisticTypeChecked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and update the config:

```js
// eslint.config.js
import react from 'eslint-plugin-react'

export default tseslint.config({
  // Set the react version
  settings: { react: { version: '18.3' } },
  plugins: {
    // Add the react plugin
    react,
  },
  rules: {
    // other rules...
    // Enable its recommended rules
    ...react.configs.recommended.rules,
    ...react.configs['jsx-runtime'].rules,
  },
})
```
