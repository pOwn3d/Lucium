import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { envFilesSettingFeed } from './src/main/platform/update-feed-env'

const shared = resolve(__dirname, 'src/shared')

/** A build carries the addresses of the update feeds only from --update-feed and --test-feed of scripts/build-drm-release.sh, never from a .env file (update-feed-env.ts). */
function refuseFeedInEnvFiles(mode: string): void {
  if (mode !== 'production') return
  const found = envFilesSettingFeed(__dirname)
  if (found.length > 0) throw new Error(`${found.join(', ')} sets MAIN_VITE_UPDATE_FEED or MAIN_VITE_UPDATE_FEED_TEST: remove it, the addresses of the update feeds are given by scripts/build-drm-release.sh --update-feed and --test-feed only`)
}

/**
 * `pnpm test:engine` builds the main process with its function and class names kept (LUCIUM_KEEP_NAMES=1): the zero-cost checks of the engine test
 * (src/main/smoke-features.ts) tell which code made a timer or a subscription by those names, which a minified bundle renames. The code is the shipped one.
 */
function keepNames(): boolean {
  return process.env['LUCIUM_KEEP_NAMES'] === '1'
}

// Production bundles are minified (electron-vite leaves them unminified by default); the development build keeps its readable output.
export default defineConfig(({ mode }) => (refuseFeedInEnvFiles(mode), {
  main: {
    resolve: { alias: { '@shared': shared } },
    // Readability's source is put into the bundle as text (`?raw`, see engine/reader-mode.ts): it runs in the pages, not in this process.
    build: {
      externalizeDeps: { exclude: ['@mozilla/readability'] },
      minify: mode === 'production',
      rolldownOptions: { output: { keepNames: keepNames() } }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    // A sandboxed preload cannot require() from node_modules: bundle electron-chrome-extensions' action list into it.
    // Each preload is one file with everything it needs: a sandboxed preload cannot require() another file, so a chunk shared between two entries
    // (the catalogues of i18n, once the preloads reach a module that translates) would break all of them at load.
    build: {
      externalizeDeps: false,
      minify: mode === 'production',
      isolatedEntries: true,
      rollupOptions: {
        // `index` is the UI preload; `extension-shims` runs inside extension service workers and pages to provide chrome.sidePanel and friends.
        // `media-bridge` runs in the main frame of every web page (Electron loads a session preload into the main frame only): the MediaSession handlers of a site and the volume of a tab for the media player.
        // `dialog-bridge` runs in the main frame of the web pages: the `window.prompt()` Electron leaves without a box.
        // `chrome-app` runs in the main frame of the web pages: the `window.chrome.app` a Chrome has and Electron lacks, which Google's sign-in looks for,
        // and what a page reads of a permission nobody answered yet (permission-state.ts).
        // `page-guard` runs in the main frame of the web pages only while the blocker's scriptlets or the fingerprint protection are on, and in the
        // service workers of the web while the fingerprint protection is on.
        // `password-bridge` runs in the main frame of the pages of normal tabs while the password manager is on: it reports a submitted sign-in form.
        // `internal-extensions` is registered in the sessions of the tabs for the address of the Extensions page only (`lucium-ui://extensions/*`), and gives `window.lucium` to that page's top frame alone.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'extension-shims': resolve(__dirname, 'src/preload/extension-shims.ts'),
          'media-bridge': resolve(__dirname, 'src/preload/media-bridge.ts'),
          'dialog-bridge': resolve(__dirname, 'src/preload/dialog-bridge.ts'),
          'chrome-app': resolve(__dirname, 'src/preload/chrome-app.ts'),
          'page-guard': resolve(__dirname, 'src/preload/page-guard.ts'),
          'password-bridge': resolve(__dirname, 'src/preload/password-bridge.ts'),
          'internal-extensions': resolve(__dirname, 'src/preload/internal-extensions.ts'),
          // `lent-tab` is registered with the shims in the sessions that load an extension, for the pages of the web: it does nothing until the main process asks it, for a tab the user
          // lent to an extension with a click, to give the script the extension injects there its `chrome.runtime` and `chrome.storage` (src/main/engine/lent-tabs.ts).
          'lent-tab': resolve(__dirname, 'src/preload/lent-tab.ts'),
          // `window-share` runs in the command window of the annotated window share only (docs/design/annotation-partage-fenetre.md).
          'window-share': resolve(__dirname, 'src/preload/window-share.ts'),
          // The view window of the same share: it receives the drawing actions and nothing else.
          'window-share-view': resolve(__dirname, 'src/preload/window-share-view.ts'),
          // The command window of the annotation of a page (docs/design/annotation-partage-fenetre.md, section « Annotation directe dans la page »).
          'page-annotate-command': resolve(__dirname, 'src/preload/page-annotate-command.ts'),
          // The helper page of a capture of the sound of a tab (engine/tab-capture-helper.ts): one function that sends a chunk of sound to the main process, in that page and no other.
          'capture-helper': resolve(__dirname, 'src/preload/capture-helper.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': shared } },
    plugins: [react()],
    build: {
      minify: mode === 'production',
      rollupOptions: {
        // UI surfaces: the sidebar chrome, the overlay panels, the mini windows, the Settings window and the Extensions page.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          littlearc: resolve(__dirname, 'src/renderer/littlearc.html'),
          // The bar of Lucium's floating video window (« Image dans l'image »), laid over the page it floats.
          'floating-video': resolve(__dirname, 'src/renderer/floating-video.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          taskmanager: resolve(__dirname, 'src/renderer/taskmanager.html'),
          about: resolve(__dirname, 'src/renderer/about.html'),
          extensions: resolve(__dirname, 'src/renderer/extensions.html'),
          // The annotated window share (on by default; LUCIUM_ANNOTATE=0 turns it off): the view window and the command window.
          'window-share-view': resolve(__dirname, 'src/renderer/window-share-view.html'),
          'window-share-command': resolve(__dirname, 'src/renderer/window-share-command.html'),
          // The command window of the annotation of a page (the same switch).
          'page-annotate-command': resolve(__dirname, 'src/renderer/page-annotate-command.html')
        }
      }
    }
  }
}))
