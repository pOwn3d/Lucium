# Images for the documentation

This folder holds the screenshots and other images used by the README and the documents. Every image here is taken from Lucium itself by `pnpm captures:site` (a throw-away demonstration profile, pages of the reserved domain `.example`), and none may be invented or copied.

## Rules

- **No personal data.** Use a fresh profile and a throw-away space with neutral content (for example pages of `example.com`, or a local test page). Before saving, look at the whole image: tab and folder titles, space names, addresses, the favourites grid, the downloads list, extension icons and badges, the account in a page, the wallpaper, the menu bar clock and the user name in a path.
- **Only Lucium.** No screenshot of another browser, and nothing that includes assets taken from another browser or from another proprietary product (see the [no-reuse rule](../../CONTRIBUTING.md#the-no-reuse-rule)). A comparison with another browser is described in numbers, not shown in images.
- **Content you may publish.** Web pages shown in a screenshot belong to their authors: use pages you own, public-domain or openly licensed ones, or a blank test page.
- **Format.** PNG (or WebP) of 1600 pixels wide at most, taken at "Retina" scale and reduced; a few hundred kilobytes each. Light and dark variants of the main view are welcome.
- **Names.** Lower case, hyphenated, describing the content: `sidebar-two-spaces.png`, `command-bar.png`, `split-view.png`, `theme-editor.png`, `settings.png`.
- **Alternative text.** Always give a meaningful description where the image is used in Markdown.
- **Light recordings** (animated GIF, WebP) stay under 2 MB.

## Used by

`README.md` (the English images) and `README.fr.md` (the same views, in French, with the suffix `-fr`):

| File | What it shows |
|---|---|
| `sidebar-two-spaces.png`, `sidebar-two-spaces-fr.png` | The whole window: the sidebar with the Work space, favorites, pinned tabs, a folder and the tabs of the day, and a page |
| `command-bar.png`, `command-bar-fr.png` | The command bar open over a page, with a calculation and its result |
| `split-view.png`, `split-view-fr.png` | Two pages side by side in a split view |

They come from `out-captures/<language>/light/<shot>-no-shadow.png` (shots `main-window`, `command-bar-calc`, `split-view`), reduced to 1600 pixels wide with `sips -Z 1600`.
