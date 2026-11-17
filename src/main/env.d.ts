// The variables electron-vite writes into the main process at build time (`MAIN_VITE_*`, read from the environment of `electron-vite build`).
// tsconfig.node.json does not load Vite's own types: only the ones the main process reads are declared here.

interface ImportMetaEnv {
  /**
   * The address of the stable update feed built into the application (scripts/build-drm-release.sh --update-feed): with the test one below, the only
   * ones the built application installs from (shell/update-source.ts). Absent from a build made without it.
   */
  readonly MAIN_VITE_UPDATE_FEED?: string
  /**
   * The address of the test update feed built into the application (scripts/build-drm-release.sh --test-feed): followed only while the
   * `updateChannel` setting is `test`. Absent from a build made without it, which then has no test channel.
   */
  readonly MAIN_VITE_UPDATE_FEED_TEST?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
