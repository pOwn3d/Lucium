# Changelog

All notable changes to Lucium are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (while it is below 1.0.0, any version may change behavior or the state file format).

How to keep it: every pull request that a user would notice adds a line to the topmost section, under the heading that fits (Added, Changed, Deprecated, Removed, Fixed, Security). At release time “Unreleased” in the heading of the version becomes its date, and the release workflow publishes that section as the release notes ([docs/community/release-process.md](docs/community/release-process.md)); the publication refuses a version whose heading still says “Unreleased”. After a release, a new `## [Unreleased]` section is opened above it. The 0.2.x versions were published on lucium.app only: they have no tag and no GitHub Release, so no link.

The “Nouveautés” sheet of the application shows the section of its version, from [CHANGELOG.fr.md](CHANGELOG.fr.md) when the interface is in French: every line added here is added there too, in French, with the same bold title then a colon.

## [Unreleased]

## [1.1.7] - 2026-11-23

This version fixes the floating video window: it now shows one bar, Lucium's, and no longer the controls of the site's player.

### Fixed

- **Picture in Picture, a single bar**: in the floating window of a video (a Twitch live, for example) only Lucium's bar remains: pause, volume, live or position, and the button that gives the video back to its tab. The site's own controls and the header are hidden; they were shown twice before.
- **Picture in Picture, no more black window on a large Twitch page**: when the video nearly filled the window (Twitch signed in, chat folded), the floating window could stay black and the tab, once the video was given back, showed no player. The player is now only the box around the video, never the page around it.

## [1.1.6] - 2026-11-23

This version brings a safer and more private browsing (safe browsing, network protection, third-party cookies, a JavaScript switch per site, warnings before a risk), new ways to work (tab reminders, focus mode, full-text search of visited pages, tab overview, one Space exported to another Mac) and a Discover Lucium panel with a tip of the day.

### Added

- **Always on Top**: View › Always on Top keeps the window above the windows of other applications, so it stays in view while you work elsewhere. The choice is per window, unchecked at each launch, and nothing runs while it is off.
- **Reopen the last closed window**: File › Reopen Last Closed Window brings back the last window you closed, in the same place, with its name and the tab it showed. The last ten are kept in memory only, gone when Lucium quits. Private and guest windows are never kept; nothing opens while the app is locked.
- **Pick up where you left off?**: After Lucium stopped unexpectedly (crash, power cut), a sheet at the next launch lists the tabs of the day: uncheck those you do not want back, they go to the archive (“Undo” returns them). Pinned and private tabs are not offered. It never shows after a normal quit.
- **Lock for private windows**: Settings › Privacy and security › Lock options › “Lock private windows after”: Never, 1, 5, 15, 30 minutes. A private window left alone (no click or key, or in the background) covers itself with the lock screen and asks for the phrase or Touch ID. Needs a lock phrase.
- **Command-line options for windows**: With “Commands by address” on, `--new-window` opens a window with the command bar and `--private-window` a private one, from a second launch of the program or the first. With the setting off they are ignored, and a locked app opens no window.
- **Bypass tracking redirects and AMP pages**: Settings › Privacy and security › More settings › “Bypass tracking redirects and AMP pages”, off by default. A link through a tracking redirector or an AMP page opens the site’s own address, by a local calculation; no request is sent. A list of sites keeps their links as they are.
- **Clear history for a period, or keep it only for a while**: History (⌘Y) › “Clear a period…” (last hour, today, 7 days, 4 weeks, all), undoable for a few seconds. Settings › Privacy and security › History and data › “Keep history” (7, 30, 90 days, a year) forgets old pages. Off by default; local only.
- **Tab overview**: Tabs › Tab Overview (⇧⌘O) opens a grid of thumbnails of the open tabs, with search, close and move to another Space. Off by default.
- **Safe browsing**: Settings › Privacy and security › Safe browsing. Before a page opens, Lucium compares its host with a list of phishing and malware sites that comes with the application, and warns first. Off by default; the check is made on your Mac, nothing is sent or downloaded.
- **Tip of the day and “Discovery path”**: at the top of Discover Lucium, one tip a day (never twice the same day, turned off in one click) and four steps to tick to get started. Both stay on this Mac; nothing is counted or sent.
- **Clear everything in one gesture**: Archive › Clear All… and the command bar clear the cookies, storage, cache and history of the profile (or of all), sparing the sites you list; “New identity…” also closes its tabs and opens a new window. Option: clear every site at quit. Containers are not cleared.
- **Extension APIs, and a block list**: extensions can use `chrome.management.getAll`, `chrome.sessions` (recently closed tabs, never private ones; off with the extension data switch), `getMatchedRules` and the body of a request. A listed extension is refused and switched off, no network; the list ships empty.
- **Discover Lucium**: Help › Discover Lucium, the command bar and a button on “Start here”, the welcome sheet and the news sheet open a panel with every function of Lucium, by task: where to find it, its shortcut, “Try it” and “Adjust”. Nothing is counted or sent.
- **Animated demos in Discover Lucium**: eight cards (reminders, focus mode, Markdown, one-time codes, command bar, split view, captures…) show a short looping scene, with a text that says what you see and a pause button. It moves only on screen, and stays still if you ask for less motion. Nothing is downloaded.
- **More cards in Discover Lucium**: guest window, setting a space aside, naming a window, reading aloud, and the everyday commands (reopen the last closed tab, mute, pin or duplicate a tab, save as PDF, print, zoom), each with its exact menu path.
- **One Space to another Mac**: Spaces › Export This Space… saves one Space with its tabs, folders and archive to a file, sealed with a passphrase if you wish; Spaces › Import a Space… adds it on another Mac, with no server. No cookies, no passwords.
- **Scroll position restored after a relaunch**: Settings › Tabs and windows › “Restore the scroll position of tabs”, off by default. A tab comes back to where its page was scrolled. Only a number per tab and its address is kept, on your Mac; never the page, nothing for private tabs.
- **Tab reminders**: right-click a tab › Remind me › This evening, Tomorrow morning or In a week. The tab comes back then, in its space, with a notification. File › Tab reminders lists them. Off in Settings › Optional features.
- **Search the content of visited pages**: keeps the text of the pages you read on your computer, to find a page by a sentence in History (Settings › Privacy and security › More settings). Off by default; nothing is kept while History is off; never private tabs or passwords; nothing is sent.
- **Focus mode**: Settings › Optional features › Focus mode keeps a list of sites closed during a timer (25 minutes by default) or a weekly time slot. A blocked site shows a clear page with “Take a 15-minute break” as the way out. Off by default; nothing leaves your Mac.
- **Bookmark and history prefixes in the command bar**: type `*` or `^` alone or followed by a space (`* recipe`), or `@bookmarks` / `@history`, to search only your bookmarks or your history. A search such as `*.example.com` or `^2`, and a custom site search keyword that starts with `*` or `^`, stay what they were. With no text after it, the bar lists them. Everything stays on this Mac.
- **Network protection**: three new switches, all off. Block tracking pings, send other sites only the origin of the page (no path), and open HTTPS sites only, with a warning page and “Continue over HTTP”.
- **Warnings before a risk**: three switches, on by default, all decided on your Mac. A box before a program or script is saved, a warning page for a typed address one letter from a site you use, and a question before a password goes to an `http:` address.
- **Block third-party cookies**: Settings › Privacy and security › Third-party cookies. Content from another site than the tab’s neither receives your cookies nor can set its own, WebSocket included. Off by default, with a list of sites where they stay accepted. Scripts’ own `document.cookie` is not touched.
- **JavaScript switch per site**: a “JavaScript” row in the site panel turns the scripts of a site off. The page reloads without any script, and a notice or the row turns them back on in one click. Off for no site by default; Lucium’s own pages are never affected.
- **Save Page as Markdown**: File › Save Page as Markdown… and the command bar save the page’s main content in one click: a `.md` file and a `<name>-images/` folder beside it. A private tab asks first; a folder that exists is never reused (`-2`).
- **Markdown export loads lazy images**: the page is scrolled from top to bottom first, as “Page entière” does (at most 80 steps, position restored), so that images that load on scroll are fetched; the message says how many still had no address.
- **Reminders keep the container**: a tab put away with “Me le rappeler” comes back in the container it was in, while that container exists.
- **One-time codes (TOTP) in the password vault**: a login can hold the key of its two-step codes (base32 key or `otpauth://` address). The panel shows the code with its countdown and copies it, cleared after 30 seconds. The key stays encrypted in the vault and is never logged. RFC 6238, nothing filled into a page.
- **Password vault care**: weak and reused passwords are flagged; “Copy password” clears itself after 30 seconds and at lock; Touch ID can be asked at every fill; “Never offer for this site” skips chosen sites. A login also fills on its `www.` twin. Nothing leaves your Mac.
- **Find in page: case, whole words, accents**: with “Advanced find in page” on, the find bar has four buttons: case, whole words, accents and regular expression. Whole words skips “chat” inside “chatte”; accents tells e from é. Off, the bar is unchanged. Nothing is sent.
- **Search engine for private windows**: Settings › Navigation › “Engine for private windows”. Empty by default, private windows follow the other windows’ engine. Chosen, only they use it; what you type is still never sent for suggestions, and no request is added.
- **Forget permissions of unvisited sites**: Settings › Privacy and security, off by default. The camera, microphone and other answers of a site not visited for 30 to 365 days are taken back, and a notice names the sites. Only one visit day per site is kept, once a day, never in private; erasing history erases it.
- **Hosts blocked on this page**: the site panel lists, page by page, the hosts the blocker stopped (up to 100). The list lives in memory only, is emptied at each navigation, and is never kept for private tabs.
- **Urgent security notice**: when the signed update feed says a version fixes a flaw, the update notice names it and ignores its cap of three showings. Nothing more is requested, and the frequency of checks does not change.
- **Security check**: Settings › Privacy and security › Security check reads, without changing anything, your extensions, remembered permissions, protections, updates and password vault, with a shortcut to each setting. Only counts are shown; nothing is measured or sent.

### Changed

- **Picture in Picture in Lucium’s window, from the site too**: a site’s Picture in Picture button (Twitch, YouTube…) and the automatic picture open Lucium’s floating window, not the system’s. A live stream shows “LIVE”, with no progress line and no ±10 s. A switch in Settings › Tabs and windows turns it off for the site’s button.
- **Permission prompt, “Allow this time”**: with “Remember for this site” unticked, the button reads “Allow this time”. That yes was already held for the tab only and forgotten with its page, never written or sent. Private tabs keep “Allow”.

### Fixed

- **Live stream with a finite duration**: a live stream whose player reports a finite, growing duration (Twitch) is recognised as live in Lucium’s floating window, so the ±10 s buttons are hidden.
- **Command bar ranking of a lost profile**: when spaces of a missing profile go back to the default profile, the ranking of that profile's command bar is dropped with it, as it already was at the next launch.
- **Full-page capture scrolls the page**: “Page entière” now walks the page from top to bottom before shooting, so a site that scrolls in a panel of its own is captured whole, lazy images are loaded, and a fixed header shows once. A page taller than 16 000 pixels is cut there, and Lucium says so.

## [1.1.5] - 2026-11-20

Your iPhone can now synchronize with your Mac, directly and without a server, and its Today tabs can be shared. On Windows the window draws its own title bar, and Windows and Linux say that they update by hand.

### Added

- **Synchronization with your iPhone**: Settings › Downloads and files › Synchronization pairs an iPhone by QR code or typed code, with Allow or Deny on the Mac. Off by default. Once paired, the iPhone synchronizes by itself, every minute or at your pace, deletions included. Cookies and passwords are never sent.
- **Today tabs shared with your iPhone**: a “Today tabs” category of the Synchronization page, off by default and ticked on both devices. Opening or closing a Today tab on one does the same on the other at the next exchange. Addresses and titles are sent, never cookies or sign-ins.

### Changed

- **Windows and Linux, updates by hand**: these versions carry no update address and install nothing, and Lucium now says so. “Check for Updates…” and the About window offer the download page of lucium.app instead of naming a setting nobody wrote, and Settings shows a sentence in place of the automatic-check switch. macOS is unchanged
- **Windows, one title bar**: the main window, the other and private windows and the windows of a site opened as an application draw their own title bar. The three buttons of Windows lie over the toolbar, in the colours of the theme, and a ☰ button at its start opens the menu. The mini window and Settings keep the title bar of Windows.

### Fixed

- **Linux, AppImage on Ubuntu 24.04**: started from the file manager, the AppImage opened nothing: Ubuntu restricts what the sandbox needs, and Lucium, which never runs without it, only said so in a terminal. It now shows a box that says why and advises the .deb package. The sandbox is still never switched off
- **Menu bar, reopening a closed tab**: “Reopen Last Closed Tab” could stay greyed out after a tab was archived, when the menu was asked to change while it was still being built. A change asked during a rebuild is now noted, and the menu is read again once it is in.

## [1.1.4] - 2026-11-18

A tab put to sleep wakes with its Back and Forward pages, an extension made of pages only opens its popup at once, and the framing of a tall background video keeps its frame on the video. The additional permission for the App Store is added to the license.

### Added

- **License, App Store**: a second additional permission (GPL version 3, section 7) lets the maintainer hand out the iPhone and iPad application through Apple’s App Store and TestFlight, its source staying whole under the GPL. Text: `ADDITIONAL-PERMISSION-APP-STORE.txt` and `NOTICE`. The application is not published yet.

### Fixed

- **Sleeping tabs, Back and Forward**: a tab put to sleep to free its memory kept only its address, and woke without the list of the pages it had gone through. The list was read after the page was already closed. It is now read just before the close, and the tab wakes with its Back and Forward pages.
- **Windows, links under a file name**: the files Lucium writes (state, history, vault, download records) and a download that resumes are no longer opened through a link left under their name. Windows cannot make `open` refuse one, so the name is now looked at first.
- **Default browser, Windows**: Settings no longer says Lucium is the default browser while Windows opens links in another one. The state is what Windows holds for http and https, read again when you come back, and “Make Default Browser” opens Windows Settings on Lucium, where the choice is yours.
- **Spelling dictionaries, Windows and Linux**: Chromium no longer downloads the dictionary of the system language from its CDN at the first launch, with the checker off. A session starts without a language: nothing is fetched until you switch Spelling on in the Edit menu.
- **Background video, framing**: in “Customize Space…”, the still picture of “Video framing” was stretched to the width of the panel for a video taller than wide (the nine videos Lucium comes with are 9:16), and its frame came out of the video. The picture now keeps the shape of the video.
- **Extensions without a service worker**: a click on the icon of an extension made of pages only (a popup, no background worker) opens its popup at once instead of after 10 seconds, and Lucium no longer logs a failed start for it. It reads the manifest, which says there is no worker to wait for.

## [1.1.3] - 2026-11-17

A link dragged from another application opens in a new tab, “Open With” lists Lucium for PDF documents and pictures, a folder can wear an emoji, and the mini window opens centered and on top. A crafted site icon can no longer freeze Lucium, and the update box names the version that was really downloaded.

### Added

- **Links dropped on a window**: a link dragged from another application (a mail, a document, a terminal) onto a Lucium window opens in a new tab, in the Space on show. Only http and https addresses with no user name or password open, ten at most; a notice says how many were left out.
- **Open with**: “Open With” in the Finder lists Lucium for PDF documents and pictures (PNG, JPEG, GIF, WebP, SVG), never as the default application for them.
- **Folder icons**: “Change Icon…” in a folder’s menu puts one emoji on it in place of the drawing, with the picker of the Spaces, on a folder made by hand as on a live one. “Remove icon” brings the drawing back; with no emoji, nothing changes.

### Changed

- **Mini window, centered and on top**: a mini window opens in the middle of the screen the link comes from (the pointer’s screen for a link from another application) and stays above the other windows. The command bar of “New Mini Window” opens there too. It does not yet go over an application in full screen.

### Fixed

- **Site icons**: a crafted icon file, a kilobyte of comments in a row, could freeze Lucium: the check that tells a vector icon from an error page took exponential time on it. It now reads the start of the file in linear time.
- **Guest window, language**: a guest window now uses the language of the interface chosen in the main window, not the language of the system. On a Mac in English with the interface set to French, a guest window turned the menu bar and its own notices English as soon as it took the focus.
- **App icon, other profiles**: a second Lucium on another profile (a test, a capture, a measure) no longer takes the icon chosen in your profile off the application. Only the profile that put an icon takes it off, when it goes back to the default one.
- **Update, version shown and withdrawn**: after “Install”, the box and the withdrawal of a version follow the version Squirrel really downloaded, read from its release name, not the one offered earlier. A version published between the offer and the click was announced as the old one.

## [1.1.2] - 2026-11-17

The sign-in on accounts.google.com and accounts.youtube.com no longer stays on a blank page after a redirect, as it could in 1.1.1.

### Fixed

- **Account sign-in, blank page**: on accounts.google.com and accounts.youtube.com, a sign-in that went through a redirect could stay on a blank page. The engine’s identity now changes only when a navigation starts; a redirect onto these hosts, or off them, is cancelled and sent again as a navigation of its own.

## [1.1.1] - 2026-11-16

A button opens the Extensions page from the site panel, a frame picks the visible part of a background video, and a script an extension injects after a click on its icon gets chrome.runtime, chrome.storage and messages. Accounts that were refused on accounts.google.com now sign in.

### Added

- **Extensions page, one click from the site panel**: the row of the extensions in the site panel ends with a puzzle-piece button that opens the Extensions page in a tab (the one chrome://extensions stands for), beside “+” and the folder, whether or not the Web Store is on.
- **Background video, choose the visible part**: a video wider or taller than the sidebar is shown whole, in “Customize the space” and the theme editor, with a frame the shape of the sidebar. Drag it, or move it with the arrow keys, to pick the part that shows; “Center the video” goes back to the middle. Kept for each space.

### Changed

- **Public suffix list**: updated. A shared Tweak (link or file) aimed at `kawasaki.jp` or `compute.amazonaws.com`, which stand for a whole family of sites, is now refused, as one aimed at `co.uk` or `github.io` already was.

### Fixed

- **Extensions, script injected after a click**: a script an extension injects into a tab you lent it with a click on its icon (`activeTab`) now has `chrome.runtime`, `chrome.storage` and messages with its worker, as the extension API says. It had none, so such an extension had to declare the script in its manifest.
- **Extension log**: an extension page without context isolation (an offscreen document, the background page of a Manifest V2 extension) no longer fills “Errors and journal” of chrome://extensions with five warnings it did not cause: four about contextBridge, one from the extension library.
- **Account sign-in**: on accounts.google.com and accounts.youtube.com, Lucium now shows the engine’s own identity (its user agent, no `window.chrome.app`, no client hint of its own), not the ordinary browser identity of the other sites. Accounts refused there (“This browser or app may not be secure”) now sign in.

## [1.1.0] - 2026-11-13

### Added

- **Work views**: a tile after the favorites opens 2 to 4 sites chosen ahead in a split view with one click, in their places and proportions; a second click brings the view back as you left it. Save one from the menu of a tab of the split view, or the + menu; the command bar and the Dock menu offer it too.
- **Proxy of a profile, tabs that do not use it**: a tab in a container or a private tab leaves through the general proxy, never through its profile’s. When its profile has a proxy that sends the traffic another way, the tab wears a small mark with a tooltip that says why.
- **Page annotation, one-letter keys**: a switch “One-letter keys for annotating”, on by default, in Settings › Optional features. Off, the tool letters, E and X (which clears every page of the session) do nothing and the page keeps them; the bar’s buttons, ⌘Z, ⌥⌘⌫, ⇧⌥⌘⌫ and Esc stay.
- **Simpler Settings**: a search that understands your words, presets, nothing hidden. The window has a sidebar; each page shows what matters at its top and keeps the rest under “More settings”, which says what it holds.
- **Settings, Start here**: the first page gathers the choices of the first minutes (theme, size, search engine, protection, passwords, launch, sleep, archiving, downloads, language, default browser, import); they are the settings of their category, not copies. The guide “Set up in a few questions” has only one entry, here.
- **Settings, presets**: “Protection level” (Standard, Enhanced, Strict), the sleep, the launch and the links from other apps are set with one choice that writes several values, at the top of their page. A notice says how many changed, with “Undo”; “Custom” when none matches.
- **Changed settings**: a row no longer at its default has a dot and “Restore”, which also puts back every setting of a preset, and its page a dot. “Changed settings”, at the foot of the sidebar, shows them all with their controls and “Restore all”; each return to the default can be undone for 8 s.
- **Settings, Optional features**: the 29 features to add (tab tree, containers, web panels, notes, QR code…) leave their category for this page: one line each, with the first sentence of what it does, its cost said in a sentence and “Learn more”. The other rows no longer carry a cost mark.
- **Settings, subpages**: lists and editors (sites kept awake, exceptions by site, filter lists, encrypted DNS and proxy, remembered permissions, keyboard shortcuts…) open on a page of their own, from a row that tells their state (“3 sites”). Back, or Escape, returns to that row; the search still finds them.
- **Optional features, filter**: “All / On / Off”, above the catalogue, keeps only the features in one state, in the order of the themes, and says how many lines it shows; the arrow keys set it. A search result that leads to a hidden feature goes back to “All”.
- **Space background, automatic veil**: a picture or video you add gets a veil set from how bright it is, dark with light text or light with dark text, so that tab titles, sleeping ones included, stay readable (4.5:1). A setting made by hand is kept; “Back to the automatic setting” measures again.
- **Picture in Picture for video calls**: the button of a video call site that opens a small window above the others, with its buttons (microphone, camera, hang up), now opens it. It keeps the site’s session and closes with its page. Experimental and off by default (Optional features): off, the request fails as before, without a tab.
- **Extensions, blocking listeners**: the blocking `chrome.webRequest` listeners of a Manifest V2 extension loaded from a folder now act: a cancel, a redirect (to the web or its own files), headers added or removed, the credentials of a login. A request waits one second at most for them; a Manifest V3 extension’s are still only told.
- **Notes, all notes**: under the header of the panel, “This page”, “This Space” and “All” choose what the list shows, with its count and its search. The panel opens on the page when the page has notes, otherwise on all of them; each note says what it is tied to and opens without changing tabs.
- **Notes, one toolbar button**: the “New Note” button is gone; “All Notes” stays and opens the panel on “All”, where a note is made too (File › New Note and ⌥⌘E still work). A switch in Settings › Optional features, under Notes; never in a private window.
- **Files of the disk**: a page, a PDF, a picture, a text or a video opens in a tab with a double-click in the Finder, “Open With Lucium” or the icon of the Dock, and when it is dropped on a window (ten at most at a time). A type a tab would download is refused, with a notice.
- **Extensions, sound of a tab**: an extension can capture the sound of a tab (`chrome.tabCapture`), never its picture: captions for a video call, a recorder. Off for each extension until you allow it in its details; the tab goes silent for you, wears a mark and can be stopped there. A switch in Settings turns it all off.

### Changed

- **Contrast with a translucent window or a very light veil**: the help of “Window glass effect”, of “Sidebar opacity” and of a hand-set veil now says that the minimum text contrast is no longer guaranteed there. The automatic veil of a background you add keeps it.
- **Scroll bars, as the Mac says**: when “Always show scroll bars” is on (System Settings › Appearance), the lists that hide their bar (the tabs of the sidebar, the spaces, the tab switcher, the mini window’s results…) draw it. Lucium follows the setting as it changes.
- **Notices with an action, one time and one pause**: “Cancel”, “Reopen” and the like stay 8 seconds everywhere (the sidebar, the Settings, the deletions in the lists, the tab search, the task manager, the command bar after ⇧⌫; they were 5, 6 or 8), and wait while the pointer or the focus is on them, then go on with the time they had left.
- **New profiles, Enhanced protection by default**: a new profile also blocks cookie banners, removes tracking parameters from the addresses it opens and copies, and sends the Global Privacy Control signal. A profile from before keeps its choices and takes Standard as its reference: nothing there is marked “changed”, and “Restore” brings back Standard.
- **Settings, sidebar**: the band of tiles becomes a sidebar: “Start here”, eight categories (Appearance, Tabs and windows, Navigation, Privacy and security, Downloads and files, Extensions and tools, Keyboard and mouse, Profiles), “Optional features” and “About and updates”. The old addresses lead to the new page.
- **Settings, More settings**: the “Essentials / All settings” choice is gone. Each page keeps what is not at its top in one fold at its foot, “More settings”, whose line names the groups it holds: no setting is hidden any more without the page saying so.
- **Settings search**: it ignores common words (“text size”, “do not track”), looks at the start of words, reads the choices of menus (“dark mode”), understands usual phrasings in French and English, puts the best match first (Enter opens it) and says where to find what is not a setting.
- **Settings, texts**: each setting says its help in one line; the details (mechanism, limits, special cases) move behind “Learn more”, which keeps the former text whole. The notes of the groups follow the same rule, and a message that sends you to the Settings writes the path from the names of the pages.
- **Settings, names**: “Keep the history of visited pages” replaces “Never save history” and is on while the history is kept, in Profiles too. The lock, the GPC signal and pop-ups are named by what they do; two groups become “Tracking and HTTPS” and “Fingerprint and extended rules”.
- **Autoplay, one setting per site**: the switch “A setting for each site”, a setting of a setting, is gone. A site’s own choice always applies and “Site Info and Settings” always offers it; a profile that had it off gets back the choices already made, listed in Remembered permissions.
- **chrome://flags**: the address opens “Optional features”, where the features to add are, instead of “Start here”.
- **Set up in a few questions, one name**: “Quick Setup” is gone. The Help menu, the command bar, the import sheet and the first launch name the guide as its card does, “Set up in a few questions”; the search still finds it under “quick setup”.
- **Settings, the last page**: Settings… (⌘,) opens the window again on the page and the subpage it showed when it was closed, as long as Lucium stays open, and leaves it where it is when it is already open; “Start here” the first time. A menu, a link or an address always opens its own place. Nothing is written to disk.
- **Settings, side of the sidebar**: a menu “On the left / On the right”, named “Side of the sidebar”, replaces the switch “Place the sidebar on the right of the window”, in Appearance and on “Start here”. The saved setting does not change.
- **Keyboard shortcuts, “Reset” on one row**: “Undo the reset” stays offered for 8 seconds instead of 6, like “Cancel” after “Restore” in the Settings.
- **Play and pause, one drawing**: the floating video, a Space’s background video, pausing and resuming a download, and the animated card of a setting show the Play and Pause icons of the media player, instead of each drawing its own.
- **Thousands of tabs**: the command bar opens and answers each key without a wait, even with thousands of tabs in one space (it took up to a tenth of a second per key). Each change of a tab and the launch also cost less when there are many tabs, spaces and favorites.

- **Extensions page, Manifest V2 folder**: the Extensions page loads, reloads and packs a Manifest V2 folder, as Settings › Extensions already did, and warns on the card, under “Details” and when loading that the format is old and some features may be missing. The Chrome Web Store still installs Manifest V3 only.
- **Smaller application**: React is left out of `app.asar`, which the interface has in its bundles and the main process never loads (8 MB less).
- **Automatic Picture in Picture, sooner**: a video you are watching floats when you leave its tab after 2 seconds of playing instead of 3, so that a stream you just opened (a live on Twitch, say) floats at once.
- **Extensions page, in a tab**: `chrome://extensions` (also `/?id=<id>` and `/shortcuts`) opens in a tab of the window, with the same page, instead of a window of its own; a tab that already shows it is selected. Not in a private or guest window. A web page cannot open or read it, and extensions cannot reach it.

### Removed

- **Import from a sidebar browser, Tweaks**: the “Tweaks” category is gone from this import and from the first launch. That browser does not keep its site tweaks on the Mac, so it never imported anything. “Import a Tweak…” stays for Lucium’s own files.

### Fixed

- **Help › Lucium Status**: the menu opens “About and updates” on the group “Lucium status”, unfolds “More settings” and puts the focus there, instead of the group “About”. The “Show Log” button of an internal error leads there too, and a link to a group of the Settings puts the focus on its title.
- **Sites and public suffixes**: Lucium now reads the exact list of public suffixes for its own decisions (the third parties of the Standard blocker, the neighbours of the vault, the links of an application window). The compact list it used took a few ordinary domains for suffixes (`q8x.io`) and split such a site in two.
- **Windows with tabs of their own**: deleting a container also closes its tabs in the other windows; “Export Data” writes the tabs of every window; a site to erase at close is erased only when its last tab closes, in any window; an import no longer replaces a tab of another window.
- **Erase on close**: when one action empties more than twenty sites of the list (a space deleted, “Clear Today Tabs”), all of them are erased, not the first twenty.
- **Glance for links to other sites**: “Open Link in New Tab”, in the menu of a link, opens a tab, as it says, instead of a Glance when the option is on.
- **Save as PDF with the address**: the proposed name keeps the whole title of the page; a “/” or a “:” in it becomes a dash (“AC/DC” gives “AC-DC.pdf”), instead of keeping only what follows the last “/”.
- **Windows with tabs of their own, bookmarks**: “Export Bookmarks (HTML)”, with the Today tabs, writes those of every window, as “Export Data” does, no longer only those of the window that exports.
- **Windows with tabs of their own, “Manage Spaces”**: the number of tabs of each space, the one in the title and the one in the deletion notice count the tabs of every window, which deleting the space or putting it aside closes too.
- **Windows with tabs of their own, split views**: a split view one pane of which goes to another window (dragged, or pinned then unpinned elsewhere) stays with the window that keeps most of its panes, or is undone, instead of vanishing from both windows with its tabs still tied to it.
- **Extensions, `chrome.downloads`**: the end of a download (`endTime`) is the moment it ended, no longer the moment the extension asks.
- **Full-page capture**: a very wide page is cut at 16,000 pixels wide, as it already was in height, instead of a picture that could exhaust the memory.
- **Translation, language of the page**: the language of a page left before it was read is no longer taken for the next page’s, which then offered to translate from a language other than its own.
- **Keyboard, tabs and toolbars**: in the Tweak editor the arrows go from tab to tab (Style and Code, then CSS, JS and Eraser), and from button to button in the annotation bar; Tab stops on the tab shown only. The controls of the floating video are no longer announced as a toolbar: there the arrows seek the video.
- **Tweak editor, the code field**: a line under the CSS and the JavaScript says that Tab adds two spaces there, and how to leave the field (⇧Tab, or Esc to go back to Style). A screen reader reads it with the field.
- **Tweak editor, the Tweaks of the site**: the cross that deletes a Tweak is a 24-pixel target beside its name, no longer a 22-pixel one laid over the edge of the name, where a click could open the Tweak instead.
- **Media player and floating video, contrast**: the pause button of a muted tab, which still pauses, is drawn at 3:1 and no longer announced as unavailable. “LIVE” is written on a darker red (5.2:1), and the band behind the site's name stays dark down to the foot of the name, which keeps 4.5:1 over a white picture.
- **Capture of an area, from the keyboard**: an arrow shows an area in the middle of the window, the arrows move it, ⇧ and the arrows size it, Return captures it. The bar says so, and the buttons Whole page and Visible window name their keys, 2 and 3.
- **Annotating a capture, from the keyboard**: the picture is a stop of Tab. The arrows move a point on it (⇧ to go faster), Return starts a shape there and ends it, or opens the text field, and Esc drops the shape under way. A line under the picture says so.
- **Settings, coloured icons with Increase Contrast**: the blue, green, red and purple tiles of the rows take the accessible variants of these colours, as macOS draws them then; the white glyph reads at 4.4:1 or more, where it was at 2:1 to 3.6:1.
- **Settings, “Restore” from the keyboard**: after “Restore” on a row, on a page or “Restore all”, the focus goes to “Cancel” in the notice, which stays past its 8 seconds while it has the focus; the focus was left on nothing, out of reach of “Cancel”. “Cancel” brings the focus back to the row.
- **Optional features, the filter**: under “On” or “Off”, a feature switched the other way keeps its line, and the keyboard's focus on its switch, until the filter is changed. The line left at once, and the focus with it.
- **“Leave this site?”, a page that reloads itself**: a page that navigates by itself just after it was opened from the address bar is asked with the box of the system, as any page that leaves by itself; “Quit” no longer loads the typed address again in place of the page's own navigation.

- **Folders, start of Today**: a folder can be dragged to the top of Today, under the “New tab” row and above the Today tabs, or put there from its menu (“Move to Start of Today”); it stays there after a restart. A folder under the Today tabs could only go back above the Today header.

- **Extensions, offscreen document**: a request for the microphone or the camera made from an offscreen document of an extension is refused with a message instead of making Lucium quit.

### Security

- **A page in full screen**: when a page takes the whole window (a video, a game, a slideshow), a notice over it says for a few seconds which site it is and that Esc leaves full screen. A page could otherwise draw a sidebar and an address bar of its own and pass for another site.
- **User scripts, reading the code**: the long lines of a script wrap in the box that shows it before it is added and in its list, so code put after a long run of spaces no longer waits out of sight past the right edge.
- **“Leave this site?”**: after “Stay”, a page that tries to leave again by itself, with no click or key of yours in it since, stays where it is without the box. A site that reloads itself from its own handler can no longer keep the application frozen behind that box.
- **Extensions, `chrome.debugger`**: an extension’s session on a page is cut before a redirect takes the page to an address the extension may not debug (the Chrome Web Store), no longer only once the page has arrived.
- **Links to another application in a frame**: a `mailto:`, `tel:` or other application link asked for by a frame of another site than the tab (an advertisement, a widget) gets the plain question, which names that frame’s site: no “Always open…” box, and the yes kept for the page does not count for it.
- **`alert()` and `confirm()` of pages**: they go through Lucium’s box, as `prompt()` does: it names the site, and the box of a tab in the background waits until you show that tab instead of opening over the one on screen. The frames of a page and the windows that are not tabs keep the macOS sheet.
- **Client Hints on the page itself**: the request of a page and of its frames now carry `Sec-CH-UA`, `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform`, with the values Chromium already puts on their images and scripts. Comparing them, a site no longer sees a browser that no Chromium is; nothing more is sent.
- **Extensions, `activeTab`**: an extension lent a page by a click could read the page it sent the tab to next (a script asked right after `chrome.tabs.update`), which no extension may without a host permission. Each script now checks the lent origin in the page that runs it; a style sheet, as it is inserted. The flaw was already in 1.0.1, the stable version until this one: update to 1.1.0.

## [1.0.1] - 2026-11-12

### Added

- **Site Info and Settings, extensions**: beside “+”, which opens the Chrome Web Store, a folder tile loads an unpacked extension (a folder with a `manifest.json`). With many extensions, the row goes to a second line instead of cutting tiles off.
- **Site Info and Settings, menu of an extension**: a right click on its tile, its ⋯ button, the Menu key or Shift+F10 open a menu to turn it off or on, reload a folder, manage it, or remove it after a question. An extension that is off stays in the row, faded and barred; a click opens its menu.

### Changed

- **App icon**: the icon chosen in Settings › General › App icon stays in the Dock, the Finder and Launchpad when Lucium is closed; to do so, Lucium sets it on the app file. It takes it off before installing an update and puts it back at the next launch.

### Fixed

- **Site Info and Settings, extensions**: 12 px of air under the row of extension tiles, so that the line above the foot of the panel no longer touches them.
- **Site Info and Settings, foot of the panel**: a long security line (“Not secure: invalid certificate accepted”) and “Site settings…” no longer wrap and overflow their 32 px pills; the line grows with its text and the items go to a second row when they do not fit.
- **Extension loaded from a folder**: “Remove” on its folder in Settings › Tools and extensions › Extensions now unloads it at once from every profile: it leaves the toolbar, the Extensions menu and the site panel. It used to stay there until the next launch. The folder and the extension's data are not touched.
- **Tooltips**: a header, a row or a button whose name is already written no longer has a tooltip that repeats it and hides the top of the line below (“Collapse the Blocking section” over “Blocking”, in Site Info and Settings). There is also a little room between the header of a foldable section and its content.
- **Removed extensions**: an extension just taken out of a profile whose page or service worker still sends a listener no longer causes an error in the main process; the late message is dropped and written in the log.

## [1.0.0] - 2026-11-11

### Changed

- **A fresh start under the name Lucium**: this version does not read the data of a 0.2.x. It opens a new, empty data folder, you are signed out of every site, macOS asks again for its permissions (camera, microphone, screen, default browser…), and the passwords come back from a CSV export made before updating.
- **Share links**: the link of a Tweak starts with `lucboost1_` and the code of a theme with `luc1_`. Links and codes made with a 0.2.x version are no longer read: copy them again from this version.
- **Extensions**: the network rules of extensions (`declarativeNetRequest`: a content blocker, a header editor) and their `chrome.webRequest` listeners now apply, after Lucium's own protections. The Extensions page warns only under an extension that blocks from its code (`webRequestBlocking`): its answers are not applied.
- **Extensions with activeTab**: an extension that holds `activeTab` and `scripting` without a host permission can now run its script in the tab after a click on its icon, until the tab goes to another site. That script gets the page, not the `chrome.*` APIs.
- **Optional permissions of extensions**: when an extension asks for a permission its manifest lists as optional, right after a click or a key press, Lucium asks you with the sheet shown at installation. Your agreement holds for the profile, and you take it back on the Extensions page (Details). Without a click, the request is refused.
- **Extension loaded from a folder**: a folder whose manifest lists more than 512 permissions, sites or script pages is refused, like a package from the Chrome Web Store. It used to load, and the engine applied the whole list without it being shown.
- **Shortcuts of extensions**: a shortcut an extension suggests that a shortcut of Lucium or of another extension already holds is no longer shown as active in the Extensions menu, and the Extensions page says it does not respond.
- **Extensions page**: “Effacer” under the list now only forgets the lines shown there. It used to empty the journal of every extension, in every profile.
- **Connections table**: the README now says what the DRM variant sends at every launch to its engine's component update service for the Widevine module (the counting data of Chromium's update protocol; no setting stops it), and that the Chrome Web Store update check carries a session identifier until you quit.
- **Page summary**: it now only goes through a local model, Ollama (still optional, off by default). The online providers (OpenAI, Mistral, OpenRouter, Anthropic) and their keys are removed; a setting that named one falls back to off.
- **Page summary, Ollama on the local network**: the Ollama address may be the one of another computer of your local network, by its private IP address (never a public host). Settings then say that the page text leaves this Mac, unencrypted on the local network; a private page is never sent there.
- **Page summary, `.local` name and Tailscale**: the Ollama address also accepts a `.local` name (`my-mac.local`) and the range `100.64` to `100.127`. A name is checked each time something is sent: the request goes to the private address that was found, and nothing leaves if it leads elsewhere. A public host is still refused.
- **File menu, “Summarize Page”**: with Ollama on another computer, the three summary entries are greyed out when the tab on screen is private, instead of opening a tab that answered with a refusal.
- **Client certificate**: when a site asks for a certificate to identify you, Lucium says so in a notice in its window, which names the site, instead of the system notification. Lucium still presents none.
- **Going back to an earlier version**: the first time a version other than the one that saved your Spaces, tabs and settings starts, Lucium keeps a copy before touching them. An older version tells you where that copy is; back on the newer one, Help › Restore Data… brings it back.
- **A profile's proxy**: the Settings say that a profile's own proxy does not hold for its private tabs or its containers, which leave by the general proxy (or without a proxy when there is none).
- **French typography**: a line no longer starts with “?”, “:”, “;”, “!”, a closing quotation mark, a “%” or a unit. French texts get their non-breaking spaces when they are shown, and searches still find a label typed with ordinary spaces.
- **One name for each thing**: the site panel is “Site Info and Settings” everywhere; a Space is “set aside”, then “reopened”, in every panel, as in the menu; in French, « Replier la barre » replaces « Coller la barre », and “New capture” replaces “Redo capture” beside Undo and Redo.
- **Settings › General**: the “First Launch Guide” switch is removed. It decided nothing: the guide opens by itself on a new profile, which has only the default settings. The guide and Help › First Launch… stay.
- **Background of a Space**: the button says “Add Media…” and the messages speak of importing, no longer of uploading: the file does not leave the Mac.
- **Passkeys**: the README says not to count on them in Lucium and to keep another sign-in method. `docs/cles-d-acces.md` says what is established (no permission from Apple for iCloud Keychain, no window to choose an authenticator), what is still to be measured, and comes with a measuring page (`pnpm probe:passkeys`).
- **Package contents**: Electron's demonstration application (`default_app.asar`), copied with the engine of the DRM variant and never loaded, is no longer shipped.
- **Installing a build**: the build script keeps the 3 newest copies of the previous application (`lucium-app-backups`) and removes the older ones; `LUCIUM_APP_BACKUPS_KEEP` changes that number. They piled up without a limit, about 300 MB each.
- **Fingerprinting protection**: it now also applies to the frames of a page (those of another site, `about:blank` and `srcdoc` included), to its workers and to its service workers. Shared workers are not covered; only strict mode removes them. While an extension debugs a page, its frames and its workers are not protected.
- **Publication**: a version withdrawn from the test channel (`--withdraw`) no longer goes to the stable channel until the same archive is published on the test channel again; the wait starts again from that publication, and `--security-fix` does not lift the refusal.
- **Checking the application**: `pnpm verify:app` compares the signature with the team of the official builds, `9A9AUX9UHT`, which the README publishes with the command that reads it; `--team` or `LUCIUM_TEAM_ID` names another. The team is no longer read from the signature being checked; `--any-team` keeps that reading to look at a copy.
- **License, protected videos**: an additional permission (GPL version 3, section 7) allows combining and handing out Lucium with the Widevine module and the engine that loads it. Its text is in `ADDITIONAL-PERMISSION.txt` and in `NOTICE`; it awaits a lawyer's review.
- **Name and logo**: the logo is reserved for the official builds. The drawing (`scripts/logo/fan-logo.ts`) and the icons of the application are no longer under the GPL; `TRADEMARKS.md` says what stays allowed and what a modified version has to replace.
- **Background videos and music of the film**: they were generated by AI with Higgsfield. `NOTICE-MEDIA.md` says so: they are neither under the GPL nor under Creative Commons, and the project promises no right to reuse them.
- **Export of the public repository, files outside the GPL**: the export is refused when the logo, its icons or the generated media leave without the document that says their license, or when `NOTICE` does not name that document; the list of the files not read marks each of them.
- **Export of the public repository**: the control of the texts recognizes references to the internal reports of the later readings and to their hypotheses, and the run lists the binary files it exports (images, videos, fonts, PDFs, archives), which no rule reads, so that they are looked at before pushing.
- **Publication, a version already offered**: before anything is sent, the feed in place is read. A version the channel already offers with another archive is refused (its file would be replaced under the feed, and every installation would fail), and so is a version below the one offered.
- **Publication, disk image**: the image must hold the app of the archive. `make-dmg.mjs` writes a record with it (the sum of the image and of the executable it holds), and the publication refuses an image left from an earlier build of the same version, or one without its record.
- **Build record**: a file Git does not track in a folder the build reads (`src`, `resources`, `native`, `build`) now counts as a modified tree. It can be in the archive without being in the commit: the record says so, and the publication refuses the archive.
- **`verify-app`, translation helper**: the check now reads the identifier the helper is signed under and the protocol its bundle names, the two things Lucium asks before it starts it. Signed otherwise, the translation by macOS was silently unavailable for everyone.
- **Export of the public repository, first readings**: the control of the texts also recognizes a reference to an internal report whose axis it does not know and that carries no number of a reading; the names of hashes, encodings and standards of that shape are left alone.
- **Clear site data, protected video**: the site's protected video (DRM) licenses are cleared too when cookies and the four kinds of storage are selected, which is the default. The sheet says whether they go or stay, and the answer has its own line, "Protected video licenses".
- **Clear site data, subdomains**: with "Subdomains", the storage of every subdomain that holds data in the profile goes, even the ones no tab ever showed. The answer has a "Subdomains" line: how many were found, or a failure if the list could not be read.
- **Deleted containers**: the folder of a deleted container, which Lucium kept while a copy of the state made before a restore still named it, is removed at launch once nothing has been written in it for 30 days. The log records it.
- **Annotation bar**: it follows the light or the dark appearance, like the rest of the interface, instead of staying a white panel.
- **Second shortcut**: five commands whose shortcut cannot be typed as written on a French keyboard, or that macOS and websites use too, keep it and get a second one: ⌃⌘← and ⌃⌘→ (back, forward), ⌥⌘K (shortcut help), ⌃⌘X (clear this site's data), ⌃⌘1 to ⌃⌘9 (Spaces).
- **Extensions menu**: “Clear Domain Data” is removed. The entry did the same as “Clear Site Data Now” in the Archive menu (⌥⇧⌘X), which stays.
- **Withdrawn version: the app says so.** When the installed version has been withdrawn, Lucium shows "This version has been withdrawn" and names the version to install, in the update notice and in Check for Updates…. The list of withdrawn versions is read from the update feed Lucium already reads: no extra request.
- **“Readable mode” becomes “Page Contrast”**: the three-mode button that darkens or lightens a whole page has a new name, in the menus, the Settings and the command bar, where “readable mode” still finds it. Reader Mode, which shows the article alone, keeps its name. No setting is lost.
- **Sessions and Bookmarks, like the other lists**: a deleted session or bookmark leaves the list at once and comes back with “Cancel” or ⌘Z (eight seconds for a session, six for a bookmark), instead of a second click to confirm. ↑ and ↓ go from row to row, and a click on a row restores the session or opens the bookmark.
- **Annotation bar, color of the Space**: the pressed buttons of the bar and the preview of the zones where it can be dropped take the accent color of the Space shown in the annotated window, in light and in dark, instead of a fixed blue.
- **Automatic clearing of annotations**: the marks of an annotated page can fade away by themselves after 3, 5, 10, 20 or 30 seconds without a new mark or a click; ⌘Z brings them back. The timer button of the bar, before Undo, picks the delay; the setting is also in Settings › Tools and extensions. Off by default.
- **Additional permission in the app**: the file `ADDITIONAL-PERMISSION.txt` (the permission under section 7 of the GPL for the Widevine module) ships inside the app, beside `LICENSE` and `NOTICE`, which already repeated its text.

### Fixed

- **Site Info and Settings, Tweaks**: each Tweak's row has three distinct buttons, always in view: Edit (a pencil, opens the editor), Export (while Tweak sharing is on) and Delete (a bin, red under the pointer). They were drawn on top of one another. To rename, double-click the name or press F2.
- **Menus of the Settings**: a menu takes the width of the value it shows; a long value is no longer cut under the arrows ("Automatic (system language)", "Downloads", "After 12 hours"…). In Profiles, the introduction no longer touches the "Set up in a few questions" card.
- **Clear history, space put aside**: clearing the history of a profile also clears the previous pages kept with the archived tabs of a space put aside. They used to stay in the state file.
- **Private window**: a site's permission request (location, screen sharing…) opens in the window's panel again, and the answer is remembered for that window, instead of a system box that kept nothing.
- **Panel fields**: a panel with a field (Edit tab…) opened as the window starts puts the cursor in it again; what is typed at once is no longer lost.
- **Command bar**: with "Keywords with !" off, "!keyword" no longer starts a site search, even for one of your own keywords; the keyword without "!" still works.
- **Site search**: a search that a site on your machine declares over http (`localhost`, `127.0.0.1`) is kept again after "Add"; the notice said "Search added" and nothing was added.
- **License texts**: the application now carries the license of Electron, the notices of Chromium, Lucium's copyright notice and the list of its npm components with their licenses, beside the text of the GPL. The previous version was distributed without the first two.
- **Confirmation boxes in English**: the button that gives up (closing a window of several tabs, clearing the history, emptying the archive, removing an extension, choosing a device) reads "Cancel"; it read "Undo", as if the action were already done.
- **Keyboard shortcuts**: recording a shortcut keeps the letter you type, whatever the keyboard layout. On a French (AZERTY) keyboard, ⌘A was recorded as "⌘Q", the letter a US keyboard has at that place. A key that a shortcut cannot name ("ù", "$") no longer records another key's shortcut.
- **Tab switcher**: a shortcut made of ⌥ and a letter given to the tab switcher (⌃Tab by default) answers on a French (AZERTY) keyboard. ⌥A gives "æ" there: Lucium read the letter a US keyboard has at that place, and the shortcut stayed silent.
- **Tab switcher, early key**: Escape, or the release of ⌃, at the moment the ⌃Tab panel appears is no longer lost. The panel stayed up: Escape cancelled nothing, and releasing ⌃ then opened the selected tab.
- **Reserved shortcuts**: giving a command ⌘Q, ⌘C, ⌥⌘M or the shortcut of an extension is refused, with the name of what holds it. Before, nothing was said and one of the two stopped answering. ⌘⌫ and ⌘⌦ can now be recorded as shortcuts.
- **Duplicate shortcut**: when two commands keep the same shortcut, the menu gives it to the one you set last. Before, both carried it, and the one that answered was not always the one you had just set.
- **Notes under shortcuts**: Settings › Shortcuts says under a shortcut when sites use it too (⇧⌘X, ⌘/, ⌘]…), when macOS keeps it (⌃1 to ⌃9 with Mission Control) and when your keyboard does not give its key alone (⌘[ and ⌘/ on a French keyboard).
- **Shortcuts in tooltips**: the tooltips of the toolbar, of the sidebar and of the mini window, and the lines of the command bar, show the shortcut as you set it. "Capture Region" showed ⌥⌘Z, which never was its shortcut (it is ⇧⌘2).
- **Annotation**: when ⌥⌘P is already held by the other annotation function of Lucium (a page, or a shared window), the note says so, instead of "already taken by another application".
- **Launch**: closing the window within a second of the launch no longer writes an "internal error" in the log; the first-launch sheet is no longer opened on a window that is already closed.
- **Contrast**: on a site that colors the toolbar (a brand blue, red or green), the buttons and the address take a dark, readable ink; the “Site Info and Settings” panel and the downloads popover have a darker background; the main button of the first-launch guide is readable in the dark appearance.
- **Tabs opened by an extension**: a tab an extension opens in the background stays in the background. It took the place of the tab on screen, and closing it showed the next tab instead of the one you were looking at (an extension's side panel could close too).
- **Side panel of an extension**: it no longer closes when another extension sets the options of its own panel (which an extension does each time it starts again), nor when its own extension sets them for a tab you are not looking at.
- **Extension sending a tab elsewhere**: `chrome.tabs.update` with an address answers as soon as the page starts loading, as the extension API specifies. It waited for the page, and when the tab was still loading its previous page, the extension got nothing back and an error in its console.
- **Extension icons**: in a narrow window, the menu of the » button (the icons that do not fit) counts the gap between two icons; the address keeps its 180 px instead of being squeezed by icons that did not fit.
- **Private tab**: the address or the search typed in the command bar over a private tab is no longer counted in the bar's ranking, which is saved with your tabs. Nothing typed or chosen there is kept.
- **Command bar ranking per profile**: the pages you often pick in the bar move up in the profile you picked them in, and in no other. Clearing the history of a profile empties its ranking only. The former ranking, shared by every profile, starts again from nothing.
- **Forgotten page, command bar ranking**: a page forgotten in the history (⇧⌫ in the bar, the History panel, “Forget this day”) also leaves the bar's ranking, where its address stayed saved. “Undo” after ⇧⌫ puts it back in the ranking, with its rank.
- **Profile named “Private”**: it no longer takes the identifier kept for the private window. And where such a profile already exists, a private window no longer uses its search engine, its download folder or its name: it follows the default profile.
- **Search suggestions**: what you type in the command bar over a private tab, or in a private window, is no longer sent to the search engine for suggestions. What your Mac itself proposes stays: open tabs, commands, the calculator.
- **Site notifications**: a site you never allowed nor refused reads "not asked yet" again instead of "refused", and can therefore offer its notifications. After "Allow" without "Remember for this site", it reads "allowed" and its notifications are no longer refused, until the tab is closed. Nothing is kept in a private window or tab.
- **Payment or sign-in button in a frame**: a click on a button placed in a frame of another site (payment, "Sign in with…") opens its window again. It was blocked with the notice "without a click from you". A frame that was not clicked still opens nothing, and one click opens one window.
- **Fingerprint protection**: the blank window a page opens to write into (`window.open('')`) gets the same protection and the same scriptlets as the page that opened it. It got none. The frames of a page are still not covered.
- **Local translation**: the memory of the session keeps the translations site by site. A site can no longer tell, from how fast a translation comes, whether a sentence was already translated elsewhere. It is also emptied when you clear the data of a profile or of a site, or the history.
- **Passphrase asked during another question**: the passphrase request (restoring an encrypted export) is no longer lost when a page's box or an extension review goes first; it opens afterwards.
- **Summary of a private tab**: the summary opens in a private tab too. It opened in an ordinary tab, and the title of the private page was saved with your tabs.
- **Private tab and per-site settings**: the site of a private tab is no longer written in the saved settings by "Turn Off Mouse Gestures on This Site", "Always allow on this site" (blocked windows) and "Disable blocker for this site". These choices are no longer offered there.
- **Private tabs, containers and several windows**: the Glance preview of a link opens in the context of the tab the link is in (split view included), "Clear Cache and Reload" empties the cache of the tab on screen, and clearing the data of a profile reloads its tabs in every window.
- **Confirmation boxes**: Tab stays on the buttons of the box instead of reaching the settings behind it; the box grows with its message, which no longer runs under the buttons when it takes four lines.
- **Screen reader**: the button that closes the side panel and, when the toolbar is hidden, Back, Forward, Reload, the site info and the favorites star are read by their name, not by a character. In Settings, the hint and the "i" of a row are read with its control.
- **Keyboard**: the width of the side panel is set with the arrows; the "+" menu and the menu of a Tweak's title are walked with the arrows and the chosen entry is read; the "i" of Settings is reached with Tab and shows its sentence; the search field of the shortcuts shows the focus.
- **Panels**: after a bookmark or the cookies of a site are deleted, the focus comes back to the panel and Escape closes it again.
- **Media player**: from the keyboard, the title row ("Picture in Picture", "Close") opens when the focus enters the bar; Tab no longer stops on buttons that cannot be seen.
- **Sidebar contrast**: the secondary text (sleeping tabs, "New Tab", "Today", names of favorites) is measured on the real color of the space and reads on all of them, "Sand" and "Yellow" in the dark appearance included. The same for the empty page, the bar of a split view and the header of the Mini window.
- **Private window**: the address of the toolbar reads better on its blue background.
- **"Always increase contrast"**: the setting also strengthens the grays of the sidebar and the outlines of the panels and of Settings, as the macOS setting does. It only acted on part of the colors.
- **Small texts**: the place of a chosen result in the command bar, the hint of a callout in Settings, the cost marks, a shortcut that is off and the shortcut letters of the annotation bar are easier to read.
- **English interface**: the “Shortcut for this site” sheet gave its errors in French, the size button of the Tweak editor showed « Taille », and a popup with no address was titled « adresse inconnue ». All three follow the language of the interface.
- **English**: the lock and Touch ID say “passphrase” throughout, the Extensions page says “Allow in Private Windows”, and the help of a new Space no longer suggests a French word; the icons suggested from the name know English words (“vacation”, “work”, “school”).
- **Help › Getting Started**: opens the README in French when the interface is in French (it opened in English). The technical documentation of Help › Lucium Documentation stays in French, and the language setting says so.
- **Cookies by site**: the sentences agree with their number (in French, « 1 n'a pas pu l'être », « sauf 1 site gardé »); the question before removing everything is clear when the “Always keep” list is empty, and a profile with no cookie no longer shows “no cookies across 0 sites.”.
- **Settings › Filter lists**: the note on the filter syntax is one sentence; it was cut into three columns around `##+js(…)`.
- **Shortcut for this site**: the sheet only shows once the existing shortcuts are known; saving too early would have replaced the whole list.
- **Sleep**: a tab that wakes gets its Back and Forward pages again. Before, the sleep that frees the memory (the default mode) and closing the main window emptied the Back and Forward buttons. The list is kept in memory only: after Lucium is relaunched, a tab starts again from its address alone.
- **Tab containers**: after Help › Restore Data…, a container made since the export keeps its cookies and storage for as long as the copy made before the restoration exists. Before, the next launch erased them, and putting that copy back gave an empty container.
- **History and cookies by site**: switching space while the panel is open no longer makes "Forget", "Forget this day" or "Clean up" act on another profile than the one whose list is shown. The panel reads the list of the new profile again, and the "Clear browsing data" confirmation closes.
- **Notes**: a note that holds a `mailto:` link with a malformed `%` (an address pasted from a Latin-1 page, an imported `.md`) opens again. Before, it could no longer be read, edited or exported, only deleted.
- **Clearing a profile's data**: its tabs reload in every window, not only in the one the erasure is asked from. Before, another window went on showing a page that was still signed in.
- **Background of a space**: "Delete" leaves on disk the picture or video that a session copy, a copy made before a restoration or another space still names, so that restoring that copy finds its background again. The file goes at a later launch, once nothing names it.
- **Extensions, performance**: with an extension installed, each web page no longer reads twice the script that gives extensions their APIs (it now runs in their pages only), and that script weighs 18 KB instead of 952 KB: extension workers and pages start without reading the texts of the interface.
- **Page Contrast, background images**: in Dark or Light, a background image declared by a stylesheet kept in another folder than the page (`url(../img/x.png)`) is looked for from the address of that stylesheet, no longer from the page's: the image was missing, and the site received a request for a file that does not exist.
- **IPv6 in the official build**: the README no longer says that the official build turns IPv6 off and that a site answering only over IPv6 does not load in it. The switch set for that (`--disable-ipv6`) is no longer read by Chromium: it changed nothing, and it is removed.
- **Questions from sites**: keeping the screen on during a call or a video, keeping offline data and sending it once the network is back are no longer asked about. The other requests are asked in plain words (cookies inside an embedding page, local network, fonts, audio output…), no longer by their technical name.
- **Links to another application**: an “Open in the app” link (Zoom, Teams, Slack, VS Code, Spotify…) no longer does nothing. Lucium asks whether the site may open the application, naming the kind of link (`zoommtg:`), each time; if no application answers, a notice says so.
- **Links to another application, “Always open”**: after a click on such a link, the question offers the box “Always open links of this type from this site”. The yes holds for that site and that kind of link only, never for a private tab, and is removed in Settings › Privacy and security, with the site permissions.
- **Report a problem**: the report fits in the form of the site's Community page (16,000 characters at most; the form takes 20,000 and no file). When the log is full, the newest lines are kept and the report says how many older ones were left out.
- **Installing an extension**: in the sheet that lists what the extension asks for, Tab stays between "Cancel" and the button that adds it. It reached the controls of the window left under the dimmed layer, where Space acted on what cannot be seen.
- **Question left unanswered**: opening a panel (the command bar, the downloads…) over a permission request, a login a server asks for, the review of an extension or a passphrase no longer makes it vanish. It comes back when the panel closes; before, the page waited forever.
- **Tab that was moved or went to another site**: "Create a shortcut for this site" offers the site the tab shows, no longer the one it was opened on. A link that opens a tab and "Search for the selection" open it in the space the tab is in, no longer the one it was created in.
- **Downloads of a private tab or a container**: "Open Without Saving" no longer keeps the file for good there, "Ask where to save each file" asks its question, and the file goes to the downloads folder of the profile of the space. These three settings were not applied there.
- **Private tab in the command bar**: ⌘↩ on the line of a private tab opens its page in a new private tab. It opened in an ordinary tab, and its address went into the saved state and the history.
- **Undo after forgetting a page in the command bar**: after ⇧⌫ on a page of the history, the bar offers “Undo” for five seconds (the button, or ⌘Z). The page goes back in the history as it was, with its title, its visits and its date.
- **Glance**: "Copy address" removes the tracking parameters when the setting "Remove tracking parameters from copied links" is on, like the other copies of an address. If the copy fails, a notice says so.
- **Customize Space**: "Revert" also puts back the background of the space (the picture or the video, its veil, the color of the text) as it was when the panel opened, and takes away a background added to a space that had none. The button comes on when only the background changed.
- **Search in a site**: in the command bar, what you type after the pill of a site ("YouTube", a keyword of yours) is no longer sent letter by letter to the default search engine for its suggestions. Only the chosen site gets the search, when you send it.
- **Bookmarks**: editing a bookmark with an address that is refused (not a web page, or already that of another bookmark) leaves the form open and says why under the address field, which screen readers read with it. Before, the form closed and the change was lost without a message.
- **Theme editor**: Escape and "Reset" take away the background added to a space that had none when the panel opened. The background stayed.
- **Resources panel**: while the pointer is on the list, the rows keep their places and only the figures change. They were sorted again every 2 s, and ☾ or ✕ could act on another tab than the one aimed at.
- **Import from another browser**: while it reads, the browser, the profile and the tick boxes can no longer be changed. The preview that came back could no longer match what was ticked, and "Confirm Import" brought in something else than what the sheet showed.
- **Global Privacy Control**: the `Sec-GPC: 1` header also goes with the opening of a WebSocket connection. It went only with the http and https requests of a page.
- **Global Privacy Control, Lucium's own requests**: with the setting on, `Sec-GPC: 1` also goes with what Lucium asks for itself: the versions, the filter lists, the icons of sites, the translation catalogue and the Chrome Web Store. Only pages carried it.
- **Automatic copies**: the "On close" copy is also made when the Mac shuts down and Lucium has to stop without waiting. It was missing in that case; your tabs themselves were saved.
- **Interface that stopped responding**: when the interface stops several times in a row and is no longer reloaded, a notification of the Mac says so and reminds you that your tabs are saved. The window stayed blank, without a word.
- **Local translation**: a model placed by hand and then replaced translates again the texts already seen, instead of serving those of the old model until you quit. In a models folder you chose, a subfolder named like a pair of languages that is not a model is no longer deleted: it is put aside.
- **Export data**: the panel also says what the export does not contain (user scripts, filter lists, pictures and backgrounds of Spaces), that notes are in it only if their feature is on, and that the settings name sites. The README says what clearing a site leaves (protected video).
- **Interface texts**: about a hundred sentences reread, in French and in English: agreements and plurals (“12 unread messages”), unclear sentences rewritten, words of the code removed, the panes of macOS named as the system writes them, example addresses on example.org.
- **Menus**: “Print…”, “Save Page As…” and “New Profile…” carry their ellipsis, and “Clear Today's Tabs” says what it does.
- **View menu**: “Cast”, which could only say that the function does not exist, is removed with its dialog. To show a page on another display, use the screen mirroring of macOS; the help says so. “Recent Notifications” is no longer in the middle of the reload commands.
- **Screen reader, language**: the mini window, the bars of the annotation and of the window share, and the shared view now say their language. With the interface in English, they were read with the French voice.
- **Screen reader, names and states**: the globe icon of a page without an icon is no longer read before the title; the loading mark and the unread badge of a tab are announced; two rows of the site panel are switches; the sheet “Shortcut for this site” is a named dialog.
- **Keyboard**: in the shortcut sheet, Tab no longer stops on each of the thirty rows; in the floating video, Space on a button reached with the keyboard presses that button (“Close” closes) instead of pausing.
- **Contrast**: the letter that stands for a missing icon, the texts of an extension that is off, the detail of the chosen row in the mini window and in the tab search, and the keys of the tooltips reach 4.5:1.
- **Screen reader, repeated buttons**: in the Settings and the history, “Remove”, “Edit”, “Forget” or “Uninstall” say what they act on (“Remove example.org”). In the list of buttons, they all had the same name.
- **Screen reader, names**: the filter of “Read Later” has a name, the swatches of the veil and of the text of a Space background are named by their color and not by a code, the log of the Engine pane is announced. “Show”, “Play” and “Pause” are no longer read as “pressed”.
- **Lock screen**: during a wait, the message is read once. It was read again at every second of the countdown.
- **Refused fields**: in five forms (sites never blocked, sites kept when cookies are cleaned, address of a search engine…), the field in error is tied to its message, which is read again when the focus comes back to the field.
- **Command bar**: the number of results is announced to a screen reader, and ⇧Tab leaves the field even when a site search is on offer.
- **Keyboard, continued**: ⇧F10 on “Back” or “Forward” opens the list of the pages of the tab; the arrows move through the groups of choices (application icon, veil, harmony of a theme, icon of a tab); Esc closes a tooltip; at first launch, the title of the step shown takes the focus.
- **Launch**: the leftovers of an import cut short are cleaned thirty seconds after the launch, no longer before the first window is shown.
- **Protected videos**: when the Widevine module arrives after the two-minute wait (a slow connection), a second notice says the videos now play, instead of leaving the first one announce a failure that is over.
- **Traces in pages**: the link hints of the Vim keys, the Eraser, the floating video, a failing user script and the error that stops a blocked script no longer leave in the page a tag, a variable, an attribute or a message bearing the name of the browser. A site could use them to recognize Lucium.
- **Mouse gesture trail**: a style rule of the page can no longer hide or move it.
- **Clearing a profile's data**: the cookies of the session of the interface go too, with the icons. Nothing in Settings erased them.
- **Client certificate**: when a server asks for one (mTLS, smart card), a notification says that Lucium presents none and that the connection may fail, once for each server. Only the log recorded it.
- **Extensions**: `Object.defineProperty`, held back while an extension without some permissions loads, is always given back intact, even when the extension library stops halfway.
- **English interface**: the English texts were reread. Turns of phrase copied from French are rewritten, a thing keeps one word (“log”, “backup”, “turned off”, “Picture in Picture”), menus and commands are in title case, tooltips and the buttons of error pages in sentence case.
- **One name per thing, continued**: “Copy Address” replaces “Copy URL”, the menus say “Back” and “Forward” where they said “Previous Page” and “Next Page”, and the bar of a split view says “Synchronized scrolling” like the menu. The French texts get the same pass.
- **Keys and gestures in the texts**: “⇧-click”, “⌥⌘-click”, “⌘Z” and “⇧F10” are written with the signs of the Mac keyboard, in the order of the menus (“⌃⇧Tab”), instead of “Shift + click”, “Cmd/Ctrl+Z” or “Menu key”, which a Mac does not have.
- **Sentences that agree with their count**: the “Empty the archive?” and “Delete the Space” boxes, the question asked before restoring data and three notices agree the sentence with the number. They said “1 tab(s) will be closed”.
- **Task manager**: the share of a processor is written in the language of the interface, “6.4%” in English and “6,4 %” in French. It read “6.4 %” in both.
- **Sizes, percentages and dates in English**: with the interface in English, a download reads “3.4 MB” and “12 KB/s” (not « 3,4 Mo »), the zoom of a site, the size of a Tweak and the size of the interface read “110%”, and the date of a live folder item and the one at the foot of a saved PDF are in English.
- **Automatic name of a session, in English**: it writes the month as a word, “Session from 10 Nov 2026 at 14:32”. “10/11/2026” read as November 10 or October 11 depending on the reader. The French name does not change.
- **One name per thing, continued again**: in English, the tabs of the day are “Today tabs” everywhere (no longer “tabs of the day”), the tooltip of the arrows says “Back” and “Forward” as the menu does, and a French sentence used in two places has one translation. In French, the update notes say « cette version », not « cette build ».
- **Shortcut for a site**: the “Create Shortcut for This Site…” sheet states the rule of the keyword and that of the address with the sentences of the Settings. The two forms refused the same entry with two rules worded differently.
- **Permissions of an extension**: the installation sheet says “Read your favorites and pinned tabs” for the bookmarks API, which changes nothing in Lucium. It said “Read and change your bookmarks”.
- **Update offer**: the notes are no longer cut in the middle of a word, but after a whole title. With the interface in English they are in English, and “Download Manually” opens the English download page. They were in French for everyone.
- **Session backups**: a backup made with “Back Up Now” and the one made before a restore are no longer deleted by the automatic backups that follow. They are counted separately: the ten most recent stay. The number in Settings applies to automatic backups only.
- **State file set aside**: the automatic backups of the lost session are no longer pushed out by those of the fresh state. The launch notice sends you to them: they stay in File › Sessions… for as long as the set-aside file exists.
- **Picture of a Space or a tab**: it is no longer deleted from the disk while a session backup or the copy made before a restore names it. Putting that copy back brings the picture back; before, the Space came back with its emoji.
- **Missing profile**: before putting the Spaces back on the default profile, Lucium copies the state file, and the box names that copy. If the folder of the profile comes back, Help › Restore Data… puts each Space back on its profile.
- **Restore Data**: the question says what an export does not hold (history, cookies, passwords, user scripts, the rules of your filter lists, the pictures and backgrounds of Spaces).
- **Emoji of a Space**: a state file edited by hand or an import can no longer put a word in place of the emoji of a Space. One emoji, one letter or one digit is kept; anything else becomes ✨.
- **IPv6 sites**: a site opened by its IPv6 address (`http://[::1]:3000`) can be added to the sites kept awake and to the sites without blocking. The address was refused as invalid.
- **Extensions from the store**: their folder, in Lucium’s data, is no longer readable by the other accounts of this Mac, like the rest of the folder.
- **Automatic appearance**: a Glance, the theme editor, the mini window and the “New Space” sheet follow macOS going from light to dark while they are open. They kept the appearance they opened with until something else drew them again.
- **Background of a Space**: the preview shows the file the Space has now. After two changes of background close together, the reading of the first file, answering late, could replace the preview of the second.
- **Extensions, blocking listener**: an extension that registers a `blocking` `webRequest` listener is warned in its console, and Lucium's log notes it: the listener is told about the requests, but what it answers is not applied. Nothing said so.
- **Accepted update of an extension**: if the new version cannot be put in place (full disk, protected folder), the installed version is loaded again at once and a message says so. The extension stayed stopped until the next launch, with no explanation.
- **Page Contrast**: on a page that keeps changing a color by script, the engine no longer writes one more rule at each value. At 5,000 rules it stops reading the elements (the recolored sheets stay), and its memories of colors and pictures are bounded.
- **Resuming downloads, finished file**: a download that ends while the window closes no longer leaves its record behind, and a file as long as the whole download is never cut or removed (on resume, when its row is removed, after 72 hours, when the setting goes off). It could be taken for a partial file and deleted.
- **Resuming downloads, record file**: a write that fails leaves no `download-resume.json.tmp` beside the file, and turning the setting off removes one left earlier. That copy kept the addresses of the downloads, tokens included.
- **Icon of a private tab**: an icon larger than 256 KB is refused before it is read whole, and a slow icon no longer lands on the page the tab went to meanwhile.
- **Sign-in window of an extension**: its repeated dialogs can be silenced, and it plays no sound without a gesture, even hidden. ⌘W closes that window and ⌘R reloads it, instead of acting on the tab behind.
- **Markdown export, notice**: the line that says a content was not converted follows the language of the interface. It was always in French.
- **Watched pages**: the text is read out of the page's reach and cut at 200,000 characters by Lucium itself. A page could hand over tens of megabytes at every look.
- **Web Store extensions, manifest**: when Lucium adds its script to an extension's content scripts, the manifest is replaced in one move, and one cut short is made again from the copy kept beside it. A crash in the middle left an extension that no longer loaded until it was installed again.
- **Find by regular expression**: a page that hands over more text than a search reads (4 million characters) is refused before the expression runs.
- **Local translation, page left**: a translation that waited its turn, or that was asking macOS about the languages, no longer runs once the tab has gone to another page or its original was asked. The other page was translated with the wrong languages, and its sentences kept under the first site.
- **Local translation, “Stop”**: “Stop” while a model is loading now stops the load at once. The panel answered “busy” and the other translations waited until the model had loaded, up to two minutes.
- **Shortcuts of extensions, key names**: a suggested key named like a member every object has (`constructor`, `toString`) is no longer taken for a key. The Extensions menu and Settings received a shortcut that meant nothing; the menu now only takes a modifier and one key.
- **Texts in English**: with the interface in English, four texts stayed in French: the favorites folder given to extensions, the name of a tab group with no title, the default name of a live folder, and the “Action” detail of automatic reload in the command bar.
- **HTTP sign-in without encryption**: with the Digest scheme over a connection in the clear, the panel now warns that the connection is not encrypted, in words of its own: the password itself is not sent, but what is sent can be enough to find it.
- **Pasting into a note**: pasting a block of code made of tens of thousands of empty lines followed by one character no longer freezes the window. The block is first cut to the size of a paste, and its extra line ends are removed without a regular expression.
- **Unreadable session copy**: when the repair of a session copy or of a file to restore fails, the reason is written to the log, and the copy is set aside for that reason. Before, the error vanished and the copy was said to have “no usable space or tab list”.
- **Folders nested by the thousand**: a state file, an export or a session copy where thousands of folders each sit inside the previous one is read without a stack error; the folders are brought back to four levels. Lucium reads at most 5,000 folders from a file, the first ones.
- **Tweaks with a script**: the script you type is kept as you type as a draft apart: nothing is lost if Lucium closes, and no page runs a half-typed script. Pages run the last saved script (“Save Script”); “Run Preview” tries the draft once in the page shown.
- **Eraser**: a change made in the panel of the Tweak while the Eraser is on no longer removes the elements you have just hidden.
- **Back and Forward**: a right click or a ⌃-click on these buttons no longer arms the long press. The menu of the pages can no longer open a second time after it was closed.
- **Settings, animated cards**: the drawing of a card is hidden from screen readers, which read its words one after the other (a fake address, key caps, the “before” and “after” states). The name of the card and its caption say the effect.
- **Sound of a tab**: for a screen reader, the button is named “Mute Tab” and says whether it is pressed. It carried the name of the state (“Muted”), without saying that a press brings the sound back.
- **Settings › Web tools**: the title “Page summary by a local model” is no longer written twice in a row.
- **Ollama connection test**: when the request does not come back, the button returns and the row says the failure. It stayed greyed on “Testing connection…” until the pane was opened again.
- **Mini window and web app, in English**: with the interface in English, the header of a site opened as an application, the Space picker and the downloads tray of the mini window no longer stay in French, and a screen reader no longer reads them with the French voice.
- **Read Later, deletions you can take back**: a deleted page, or the emptied list, comes back for six seconds with “Cancel”, as in the notes. When “Clear All” asks to confirm, “Cancel” takes the place of the first button: a double click no longer empties anything.
- **Read Later, folders from the keyboard**: two buttons move a page up and down in its folder (only drag and drop could), and the “New Folder” field has a name for screen readers.
- **Notes, text given up**: a note left with unsaved text (Escape, “Cancel”, “Done”) comes back for six seconds. “Done” first gives the note up and leaves the panel open; a second click closes it.
- **Cookies of a site, translation model**: “Delete” for the cookies of a site and “Remove” for a translation model ask for a second click, as “Clean Up” already does.
- **Encrypted DNS, “Other address”**: the address is saved when you leave the field or press Return, no longer at each keystroke: the addresses made on the way (`https://d/`, another domain) are no longer put in service. A refused address says why, and that the previous one stays in use.
- **Requests that fail**: the task manager says why its list is empty or why a process could not be ended; the “New Space” sheet no longer stays on “Creating…”; “Make Default Browser” of the welcome no longer stays greyed; “Find and Replace” says that a replacement failed.
- **Texts and sorting**: in English, the translation panel writes “Models folder:” with no space before the colon; the extensions of the Settings and the Spaces of the task manager are sorted in the language of the interface.
- **Command bar, ⇧⌫**: the key forgets a page of the history only when its line was chosen with the arrows; while typing, it deletes a letter. The bar says that the page is forgotten, and also says when forgetting it or reading the history fails.
- **Passwords, generator**: the length can be typed. It was held between 8 and 128 at each key (“3” gave 8, then “2” gave 82); it is now held when the field is left or on “Generate”.
- **Passwords, too many tries**: the wait is counted down on screen and “Unlock” stays off until it is over. The number stayed as it was, and a try made too early was sent only to be refused.
- **Passwords, locking**: what was typed while the vault was open (current, new, export or deletion phrase, generated password) is cleared from the page as soon as the vault is locked.
- **Error messages**: “Clear Site Data”, Settings › Locking and the extensions page show the sentence of the error, without the technical prefix “Error invoking remote method…” and the name of the channel.
- **First launch**: during the import, “Later”, Escape and a click outside the sheet no longer close it: the report and “Undo the import” are no longer lost. Two quick clicks start one import, and choices that could not be saved are said.
- **Resources panel**: “Tab put to sleep” and “Tab closed” are said only once it is done. For a tab that is refused or a request that is lost, the panel says that the tab could not be put to sleep or closed.
- **Annotated window share**: when a request of the command window fails (list of the windows, start, stop, passage mode, tool), it says so instead of keeping “Sharing…”, and the error reaches Lucium Status.
- **Settings, Where Links Open**: when the box opens, the cursor is in the field of the site. It was on “Remove” of the first rule, which Return deleted.
- **Clear Site Data, limit**: past 20 sites, those pasted or typed in excess are refused at once, with the sentence that says so. A long list became as many tags and as many requests to count cookies.
- **Customize the Space, profile**: choosing another profile for a Space that has tabs asks for a confirmation, since all its tabs are reloaded and signed out of their sites. The choice in the menu applied at once.
- **Accessibility**: the list of the profiles is a group of buttons that say which one is shown; the confirmation of a clearing keeps the focus; the help of the boxes of “Clear Site Data”, the reason a button is off and the name of the Space of a tab in the command bar are read.
- **Failures said**: a profile that could not be created and a download folder that could not be chosen say so on screen, instead of a button that does nothing.
- **Extensions page, journal**: an open journal that receives lines scrolls only its own list, and only if you were at its end. The page no longer moves, and reading older lines is no longer interrupted.
- **Closed panels**: a closed panel is removed from the interface's memory at once. The password typed, the capture or the list it showed no longer stay until the next panel opens, and a deletion that was waiting for “Undo” (a history page, a space) is made as soon as the panel closes.
- **Panel that fails to draw**: a panel that fails to draw closes its layer, and the question it carried (a permission, a sign-in) is answered as refused. It left an empty layer over the window and a question without an answer.
- **Site Info and Settings, closing**: a panel opened right after Esc on this panel (the command bar, find in page) no longer closes by itself.
- **Settings › Shortcuts**: “Reset all” can be undone, which gives back the shortcuts you had chosen. Each key is announced with the name of its command, and the “More actions” menu is driven with the keyboard (arrows, Esc).
- **Custom filter lists**: “Remove” asks before it deletes the list and its rules. A failure to remove a list or to update the lists is said in Settings.
- **Capture annotation**: “New capture” asks first when the capture has annotations, as “Discard” does. A click next to “Redo” no longer loses the drawing.
- **History, “Forget this day”**: every page of the day is forgotten, not only the ones the panel had loaded. The panel says when it shows only the 500 most recent pages.
- **Edit Tab**: opening “QR code”, “Translate”, “Name Window” or “Live Folder” no longer sends the tab to the address typed in the field; only “Save” does. An address that cannot be loaded, the tab being asleep, is reported.
- **Import**: the sheet no longer closes while the import is being written, by its button, by Esc or by a click outside. Closing it stopped nothing and lost the “Undo the import” button.
- **Site Info and Settings, keyboard**: the button that clears the site's data is named so for a screen reader (it was called “More”), the confirmation takes the focus, and “Cancel” on the deletion of a Tweak gives it back to its bin. “Automatic Picture in Picture” says it applies to all sites.
- **Reported failures**: when the main process fails, the theme editor (copy, paste, apply to all spaces, site color), the spaces panel (set aside) and adding an extension from the site panel say so, instead of a button that does nothing.
- **Screen reader**: “This page doesn’t declare a color”, in the theme editor, is announced, and the time of the floating video has its name.
- **User scripts**: “Remove” asks for a second click and says the code cannot be recovered. Before, a single click, right next to “Show code”, erased the script for good, even a script pasted by hand that existed nowhere else.
- **Space background, “Delete”**: the file is no longer erased at once. In the theme editor, Escape or “Reset” put the Space back on a file that was gone: an empty background that could not be read. The file is deleted at a later launch, once nothing names it.
- **Live folder**: “Live folder source” opens with the source, what is followed and the name of the folder. The sheet opened empty and everything had to be typed again to change one field.
- **Manual proxy**: the address is saved when you leave the field or press Return, no longer at every keystroke (traffic went for a moment to `host:8`, `host:80`, `host:808`). While the proxy shown is not saved, Settings say so. A connection test that could not be run says so too.
- **Requests left unanswered**: the Sessions panel says when the list of automatic backups could not be read, when a confirmed restoration failed and when a backup could not be made; Settings › General says when Lucium could not be set as the default browser. Before, nothing happened and nothing was said.
- **Sessions, Space set aside**: while the deletion awaits its confirmation, the panel writes that the Space, its theme and its tabs go with the session. This was only said in a tooltip, which neither the keyboard nor a screen reader gets.
- **Bookmarks, large library**: the list shows the first 200 bookmarks, then the next ones on request; the search still covers the whole library. After a large import (up to 5,000 bookmarks), the panel was slow to open and the search stuttered.
- **Sidebar width from the keyboard**: the edge of the sidebar takes the focus and is set with ← and → (Shift for a larger step), Home and End; a screen reader reads the width. It could only be set with the mouse.
- **Annotated window share, typing in Japanese, Chinese or Korean**: Return while a text is being composed chooses the proposed character instead of placing the half-typed text; Escape gives the composition up without dropping the text.
- **Page annotation, typing in Japanese, Chinese or Korean**: in the text box, Return while a text is being composed chooses the proposed character, and Escape gives the composition up. The box closed and placed the half-typed text.
- **Mini window header**: the title and the address of the page show even when the window opens on a very busy Mac. The header could stay empty until the page changed. The same for the header of a site opened as an application and for the downloads tray.
- **Lucium Status, interface errors**: an error the engine gives no detail of (a `ResizeObserver` loop, a script from another origin) is written with its message and its place. The log only wrote “null”.
- **Dragging an edge, then another application**: dragging the edge of the sidebar, of a panel or of a split view stops when the window is no longer in front or when the system cancels the pointer.
- **Orphan tooltip**: the tooltip of a button goes away when the button disappears under the pointer (a button of the media player when the sound stops, the tile of a tab that closes). Such a button gets no signal that the pointer left.
- **Close tab**: “Close Tab” in the menu of a tab, of a selection or of the hover card now archives a Today tab, as ⌘W does. “Reopen Last Closed Tab” finds it.
- **Close Other Today Tabs**: the open page of a favorite and the other panes of the kept tab's split view stay open, as with “Clear Today Tabs”.
- **Windows with their own tabs**: putting a space aside also keeps the tabs the other windows have in that space, and reopens them with it. The question counts every tab that closes, when a space is put aside and when it is deleted from its menu.
- **Live folders**: a copy of a live folder made past the limit of 20 is an ordinary folder, instead of one that looks live and is never read again.
- **Restore defaults**: “Restore Defaults” in the Tools category keeps the Ollama address and model you typed. It puts the switch and the sliders back to their original values.
- **Tab tree**: a very long chain of tabs opened one from another, read from a restored file, no longer stops the sidebar from being drawn.
- **Sleeping tab under the pointer**: its title keeps a contrast of 4.5:1 on every Space color while the pointer is on its row. On several dark colors it fell to about 3.4:1.
- **Restore Data, what stays from here**: the question also says that “Watch pages”, the commands by `lucium://` address and the automatic check for updates stay on or off as they are on this installation.
- **Page annotation, eraser**: moved quickly across a stroke, it erases it. It only looked at the points where the pointer was reported, and the engine merges a quick move into one: the eraser jumped over the stroke. It now erases all along its way.
- **Panels, first frame**: a panel is drawn from its first frame with the state of its window. With the sidebar at the right, the downloads popover showed for a moment at the left, over the page, before it moved into the sidebar; a busy Mac made it last longer.
- **Locked Space, “New Folder”**: in the Tabs menu, in the Space's menu (right click or header) and in the “+” menu, the entry is greyed out while the Space is locked, and its tooltip says why. It stayed active, and a click was refused with a notice.
- **Keyboard shortcuts, “Reset” on one row**: the default shortcut comes back, and a notice offers “Undo the reset” for a few seconds to get back the one you had chosen, which was lost. ⌘Z does the same, and also takes back “Reset all” and the removal of conflicts while their notice shows.
- **Awake tab under the pointer**: its title keeps a contrast of 4.5:1 on every Space color while the pointer is on its row. “Sand” in dark fell to 4.46:1, and light colors chosen in dark to 4.2:1. The ground does not change: only the text gets a little stronger, where it has to.
- **Update withdrawn after its download**: when the release file lists the version already downloaded as withdrawn (read again at the next check, by “Check for Updates…” or when quitting Lucium), it is not installed: Lucium removes what it had prepared, says so in a notice and offers the version to install. It was still installed at the quit.

### Security

- **Signed update feed**: Lucium believes the file that announces a new version only when it carries a signature made with a key built into the application. Without a valid signature, on the stable channel as on the test one, no update is offered, no version is said withdrawn, and Check for Updates… says so.
- **`chrome.debugger`**: an extension can no longer simulate a drop of files onto a page (the page would then read any file of your disk), nor a key press that pastes your clipboard into the page.
- **Local page**: a page opened from a file can no longer read the answer of a web site by asking for it in another way (`fetch` in the `same-origin` or `no-cors` mode). A shared worker of a local page can no longer ask the web for anything.
- **Invalid certificate**: a site that asked for a secure connection (HSTS) is still known after Lucium restarts, for as long as it asked, so "Continue Anyway" does not come back for it. A private window keeps nothing, and "Clear data" forgets these sites.
- **Invalid certificate, on quit**: the list of the sites that require a secure connection (HSTS) is also written when Lucium quits. A site first visited in the last second is no longer forgotten at the next launch.

- **Lucium's engine**: the distributed version leaves the prerelease engine (45.0.0-alpha.14) for its stable version 45.2.1 (Chromium 156.0.8078.75), the one Lucium is tested on, with the Chromium fixes released in between. The build now refuses a prerelease engine.
- **Start-up switches**: the built application no longer starts with the test switch `--smoke`, with the remote-debugging switches (`--remote-debugging-port`, `--remote-debugging-pipe`) or with those that weaken TLS, name resolution, the keychain or the sandbox, and it ignores the test variables.
- **Address shown**: when a page goes to an address of more than 65,536 characters (a redirect is enough), the tab shows the new site, with the address cut. It kept the name and the "Secure" mark of the site it had left, above the page of another one.
- **Extension tabs**: an extension that asks for a tab at an address that does not open in a tab (`data:`, `blob:`) gets an error. It was given a tab that was already open instead, sometimes one of another profile, which it could then navigate or close.
- **Local file opened in a tab**: a page opened from a file (`file://`) no longer reads, with `fetch` or `XMLHttpRequest`, the answer of a site, of a service on your machine or on your local network, unless the server shares it with everyone. It still shows its images, styles and scripts, those of a site included, as a saved page does.
- **Developer Mode**: it accepts an invalid certificate without asking only for a site of this Mac or of the local network (`localhost`, `.local`, a private address). A site of the internet put in Developer Mode keeps its "Your connection isn't private" page and its "Continue Anyway".
- **Invalid certificate**: a site that requires a secure connection (HSTS) no longer offers "Continue Anyway". Lucium knows it for the top-level domains preloaded as a whole (`.app`, `.dev`, `.page`, `.bank`…) and for a site that asked for it with its header during the session.
- **A site's access to your files**: the question names the file or the folder, and says whether it will be read or edited, instead of "use “fileSystem”". The "Remember" box is no longer offered: a site asks again for each file or folder.
- **Files of the application**: at launch, Lucium compares the scripts it loads into pages (reading of sign-in forms, page guard, extensions) with the hashes sealed in its archive. If one of them was changed or removed, it does not start and says so.
- **Tab icon**: the icon a page declares goes through the blocker before the sidebar loads it. A page can no longer have a tracker the blocker refuses contacted by declaring it as its icon; the tab then shows its letter.
- **Icons of sites**: Lucium downloads each icon once, in the profile of the tab (its cookies, its blocker), 256 KB at most and only a picture. The sidebar shows that copy and no longer contacts any site; it used to load every icon itself, outside the profile.
- **Locking a space**: when the space on screen locks alone (its own lock, or the Mac going to sleep), the Glance preview, an extension's side panel, the search in the page and the open panel are closed. They stayed usable over the lock screen.
- **Questions from a background tab**: a permission request, a login a server asks for or a `prompt()` box no longer appears over another tab, and the tab no longer comes to the front by itself. A notice says which site is waiting; the question opens when you go to it.
- **Password vault**: nothing is filled, or offered for saving, on a page whose invalid certificate was accepted ("Continue Anyway" or Developer Mode). On a hostile network, the password went to whoever intercepted the connection.
- **Download in progress**: the file carries the macOS "downloaded from the Internet" mark from its first bytes, no longer only once it is finished. A server that left a download "in progress" forever delivered a whole file that Gatekeeper did not check.
- **Request rules of extensions**: a rule whose regular expression can take forever on an address a page chooses (a repetition inside a repetition, a look-around, a back-reference) is left out when it is read, with a line in the journal. It could freeze Lucium.
- **Side panel of an extension**: it no longer opens beside a private tab, nor in a private window, whether the extension asks for it or its icon is clicked. The extension was told the number of the private tab.
- **User scripts and Tweaks**: code with a line that changes the reading direction, or with an invisible line ending (U+2028, U+2029), is refused with the number of the line: the code you read would not be the code that runs. Another invisible character (a zero-width space, the joiner of a composed emoji) is accepted, with a warning that names the line to read again.
- **Open Without Saving**: more macOS file types are no longer opened from the temporary folder or by a remembered application: shortcuts to a server (`.afploc`, `.smbloc`, `.vncloc`), preference panes, screen savers, plug-ins, saved pages (`.webarchive`), `.xip` archives.
- **Permission request**: a click on "Allow" that lands less than half a second after the bubble appears is not taken as an answer; the bubble stays. A page can no longer have you click fast at that spot, then ask for the camera or the microphone just before the click.
- **Saving a password**: "Save" and "Ignore" stand only for the login shown when you click. If a form submitted in another tab replaced it in the meantime, nothing is saved and the panel shows the login now on offer.
- **Web panel**: the panel closes when its space is given another profile, instead of staying open with the accounts of the profile before. And when the page of the panel leaves the site it was opened for (a link, a redirect), its name is followed by the site it shows.
- **Login removed from the vault**: the copy of the vault from before the removal (`passwords.vault.bak`) is deleted at once. It kept the removed login, encrypted, until the next change of the vault.
- **Full screen of a page**: a page can no longer keep the Escape key for itself (`navigator.keyboard.lock()` is refused). A page in full screen covers the whole window, the address included: Escape always remains the way out.
- **Address shown**: a site name too long for the toolbar, the pill of the sidebar or the header of the mini window is shortened by its subdomains; the domain itself stays whole. The mini window shows the site at every width.
- **Page with no site name**: for an empty page (`about:blank`), a local file or a `data:` address, the place of the address shows what the address says, no longer the title. A page chooses its title and could write the name of another site there.
- **Page over http**: the toolbar says "Not secure" for a page that came with no encryption, as the sidebar already did. A page this Mac itself serves (`localhost`) crosses no network: it does not get these words.
- **Extension debugger**: an extension can no longer pick an account (federated sign-in) or a device for the user, nor fill a form with a saved card. The `FedCm`, `DeviceAccess`, `DigitalCredentials`, `Autofill` domains and three more are refused.
- **Extension debugger, passkeys**: `chrome.debugger` also refuses the `WebAuthn` domain. An extension can no longer plug in a virtual authenticator, which answered a page's passkey request in place of your key and handed back the private keys it had made.
- **Lock**: a mini window, an application window, the floating video, the annotation bar or a share window still open while Lucium is locked is no longer listened to. These windows close when the lock comes; the refusal now holds even if one of them stayed.
- **Page annotation**: the layer that holds your strokes and your texts now lives apart from the scripts of the site. The page can no longer read or change what you draw or write in it. A page that was already listening to its whole window before the annotation still gets the pointer and the keys, as for anything that happens on it.
- **Page annotation, key that places a text**: Enter or Escape, which closes the text box, no longer reaches the page at all. Its release came after the box had closed, and the page got it: a site that reacts to Enter could act when you placed your text.
- **Request rules of extensions**: a rule with several `*`, or a regular expression with repetitions one after the other, can no longer freeze Lucium on a long address a page chose. A filter is compared in a bounded number of steps; an expression is only tried on an address short enough for it, or the rule is left out.
- **Request rules of extensions, journal**: when a rule is not applied to a request because the address is too long for it, or because comparing them took too many steps, the journal of the extension says so, once per rule. The rule used to stop applying without a word.
- **Lucium's own requests and extensions**: the requests Lucium makes itself (reading a page again, the images of a saved page, resuming a download) no longer go through the rules and the listeners of extensions, which could block them, send them elsewhere or read them.
- **Tab lent to an extension (activeTab)**: the loan a click on an extension's icon makes of the tab ends for good when the tab goes to another site. It came back without a new click as soon as the tab returned to the site, by a link, a redirect or the Back button.
- **Extension held by two profiles**: what an extension may do in a profile is read from the version that profile loaded. When two profiles held two versions of it, the permissions of the one loaded last stood for both.
- **Script of an extension in a lent tab**: the address of the tab is read again just before each script and each style sheet, and no longer only when the request comes in. A tab that went elsewhere while the files of the extension were being read receives nothing.
- **World of an extension's scripts**: in a lent tab, each extension has its own isolated world, given once and kept. It was worked out from its id, and two extensions could land on the same one and read each other's variables.
- **Events of an extension**: the worker of an extension can no longer subscribe to the events of another extension of the profile, nor take that one's subscriptions away. Only extension pages were checked.
- **Blocker, filter lists**: a rule of a public list with several `*`, or a costly regular expression, can no longer freeze Lucium on a long address a page chose. Those rules (fewer than 200 out of 130,000) are left out when the lists are compiled, and the engine reads only the first 2,048 characters of an address.
- **Your own filter lists**: a regular expression followed by options (`/…/$3p`, `/…/$1p`) is refused like the others; it used to pass the review. A rule the engine leaves out for its cost (two `*` with no host name) is counted among the rules it does not recognize instead of being kept to no effect.
- **Scriptlets of the blocker**: a regular expression with two repetitions one after the other (`a*a*b`, `a{0,99}a{0,99}b`) is refused; it could freeze a page for seconds. `remove-attr` no longer removes `sandbox`, `integrity`, `nonce`, `csp` or `referrerpolicy`.
- **User scripts**: `/payment`, `/pay`, `/billing`, `/signup`, `/password`, `/login;…`, `/%6cogin` and `www.login.…` are recognized as sign-in or payment pages. The text says those pages are recognized by their address, and no longer that they are "never touched".
- **Importing Tweaks**: reading the CSS of a Tweaks file no longer slows down on nested parentheses; a crafted file could keep Lucium busy for close to a minute.
- **Extension sheet**: the install sheet and the rights that are granted now read the same entries of the manifest, 512 at most per list. Past that, the extension is refused, and an update is not applied. A permission or a site written after hundreds of filler entries was granted without being shown.
- **Extension updates**: going from one site to all its subdomains (`https://example.com/*` to `https://*.example.com/*`), from `https` to every scheme, from one path to the whole site or from one port to all of them asks for your agreement again. These wider accesses were applied without the sheet.
- **Extension sheet, every site**: a pattern over a whole public suffix (`*://*.com/*`, `*://*.co.uk/*`) or over the WebSockets of every site (`wss://*/*`) is announced as access to every site, with the warning. It was shown as the domain “com” or as “some addresses”.
- **Bookmarks export**: with “Inclure aussi les onglets du jour”, the private tabs of a normal window are no longer written to the file. From the menu, the export is refused while a Space is locked, as it is from Settings.
- **Error log, freeze**: a page can no longer freeze the windows with a very long error message. Only the first 4,000 characters of an error are read, and reducing the paths takes a time proportional to the length of the text.
- **Error log, privacy**: an address whose path holds an apostrophe or a parenthesis loses its whole path and query; a path on an external disk (`/Volumes/…`) is reduced to the file name, a `mailto:` address to its domain. These lines go into “Signaler un problème”.
- **Restoring data**: a restored file no longer chooses the download folder, the folder of the translation models, the proxy or the DNS, which stay those of this installation. It no longer grants a site any permission (camera, microphone, location): only its refusals are taken. Its `devtools:` tabs do not come back.
- **Clearing history**: the list of sites Lucium already offered to add the search of (up to 200 names of visited sites) is emptied with the history. Nothing could empty it.
- **GitHub live folder**: an address received from GitHub is compared with the repository once normalised. `https://github.com/a/b/../../other/page` began like the repository and led elsewhere.
- **Proxy test**: a host name is resolved before the test, and the address it stands for passes the same filter as one written in figures. A name that pointed to `169.254.169.254` got through.
- **Password import**: in a Bitwarden export, several addresses separated by commas are read one by one. They were read as a single site that does not exist, and the login was never offered.
- **Reader mode**: the reader closes when another page arrives in the tab. Opened while a slow navigation was under way, it kept the article of the page before on screen under the address of the new one.
- **Proxy refused**: when the engine refuses a proxy, the session has no network until the setting changes, and a message says so. It went on leaving by its previous route.
- **Markdown export, images**: an answer is kept only when its type is one of the image types listed (`constructor` passed for one), and the request names only the origin of the page to another site, and nothing from https to http. The whole address of the page was sent.
- **Media player**: the marks the player leaves on the media of a page (paused, volume) no longer carry the name of Lucium. Their names are drawn at each launch.
- **Extension switched off or removed**: Lucium forgets its manifest when it leaves a profile. A page of the extension that was still open kept being answered by the APIs Lucium provides itself; its calls are now refused, as for an extension that never had the permission.
- **Locked Space, menu actions**: “Clear Today Tabs”, resetting the pinned tabs, tidying and moving a locked Space to another profile are refused, with a message. “Empty the archive” now empties only the archive that shows: the archived tabs of a locked Space stay.
- **Locked Space, restoring**: while a Space is locked, “Restore Data…”, putting a copy of the session back and undoing an import are refused, with the reason, as an export is. They replaced or removed its tabs without the phrase.
- **Locked Space, name and look**: the name, icon, theme, background, picture and header of a locked Space no longer change without the phrase. Their menu entries are greyed out, and “Apply This Theme to All Spaces” leaves it as it is. Moving it in the list is still allowed.
- **Locked Space, new folder**: “New Folder” and “New Live Folder” are refused in a locked Space, with a message, like the other changes of that Space. The other Spaces still make folders.
- **Locked Space and `chrome.bookmarks`**: an extension no longer reads the pinned tabs or the folders of a locked Space, and nothing at all (no favorites, no Space names) while the application is locked. Until now it was given the whole tree.
- **Markdown export**: a page made of a very long run of spaces or line breaks (in a code block, bold text, a link or a table cell) no longer freezes Lucium for minutes on export. The blanks at the ends are removed by a walk, no longer by a regular expression.
- **Locked Space and task manager**: the task manager no longer lists the tabs of a locked Space. It gave their titles, grouped by Space, to whoever opened it without the phrase. A private tab is named “Private tab” there, without its title.
- **Command bar ranking**: the addresses chosen in the bar are no longer counted while history is not recorded. “Clear Browsing History” empties this ranking, and clearing the history of a site removes that site's addresses from it.
- **Containers**: “Separate from Pinned Tab” keeps the page in the pinned tab's container. It used to reload outside the container, with the profile's cookies.
- **Private tabs**: a private tab's page can no longer become a web panel, which is saved with the space. A private tab's title is no longer given to the system as the window title (Mission Control, the Dock menu).
- **Glance**: the header of the preview shows the real site of the page, without the “name@” part of an address, always keeps the main domain name visible, and says “Not secure” for a page over http.
- **Restore data**: a restored file no longer decides whether Lucium watches pages, accepts `lucium://` addresses from other applications or looks for updates. These three settings stay those of this installation.

## [0.2.15] - 2026-11-10

### Added

- **The sidebar, window by window**: each window puts its sidebar on the left or the right for itself only, or docks it to a column of icons (pinned tabs, unread counts) with “Fold the sidebar”, ⌃⌘S, a right-click or the View menu. The setting still chooses the side of new windows.
- **One-click translation**: for a page in another language, a toolbar button, “Translate to English” in the right-click menu and in the File menu translate it without a panel; “Show Original” is one click away. “Always translate French” and “Never translate this site” can be undone in Settings › Tools and extensions › Local translation.
- **Lucium's Picture in Picture**: the tab itself floats in a small window on top, without reloading, with a full bar (play, sound and volume, −10/+10 s or "LIVE", back to tab). A tab whose video floats never sleeps.
- **Notes**: a visual editor with a toolbar (headings, bold, italic, strikethrough, lists, checkboxes, quotes, code, links), Markdown still underneath ("M↓"); share through the Mac's sheet, download as .md, copy, import a .md file.
- **Size of windows and panels**: set per screen in Settings › Appearance (Automatic from the screen, Compact to Extra large, or a slider with a preview); a notice offers it the first time a very wide or very small screen is used.
- **Annotation bar where you want it**: drag the handle and the edges of the window show where it snaps (a column or a row), or let it float; or click the new Position button, or right-click, to choose. A tip says so the first time. Lucium remembers the place.
- **New logo**: "the fan of spaces", in eight color versions (Settings › General › Icon), with the new Light version as the default.

### Changed

- **Clear site data**: the sheet takes the layout of the Clear Domain Data extension: domains as tags, "Include HTTP" and "Subdomains", type tiles, Auto-close, results per domain. In Settings › Privacy and security: a confirmation, a notification when the shortcut is used and an animation on the page (seven to choose from).
- **Glyphs in color**: the pencil, the note, the control center and the split view get color inside, like the Readable mode button; their outline keeps the ink of the bar.
- **Faster page translation**: what is on screen is translated first, even in the middle of a long page; a repeated text is translated once, and “Show Original” then “Translate” comes back at once (kept for the session only, never on disk and not in private windows).

### Fixed

- **Sidebar and extensions**: the sidebar's edge can be grabbed again (drag to resize); "New profile…" puts the cursor in the name field; an extension that opens its side panel on an icon click also opens it from the extensions menu when its icon is hidden.
- **QR code**: the panel draws a readable code again (its modules were blurred by the line style of the panel's icons).
- **Small fixes**: the automatic name of a session follows the interface language; searching Settings for "export" or "backup" lands on the export buttons; texts that named Chromium now say "the engine".
- **Appearance**: Lucium's appearance and the appearance asked of websites are two settings; asking websites for Dark no longer turns Lucium dark while the Mac is light. If you had forced Light or Dark for the whole app, choose it again under "Lucium appearance".
- **Translate This Page**: the panel no longer opens on the same language on both sides; it offers another language and says why. The notice that Apple may count this use no longer comes with every translation: it stays in the panel and shows once, the first time macOS translates.
- **Unread badge**: it no longer blinks with a title that keeps changing; Slack's "!" and "*" marks show it too.
- **Picture in Picture and sleep**: a tab whose video floats, even from an embedded player, is no longer put to sleep.
- **Interface crash**: the sidebar, the overlay or Settings load again instead of staying blank (at most three times a minute).
- **Annotation bar in a short window**: the top of the column is no longer lost out of reach.
- **Tracker blocking**: “Block ads and trackers” could show on while nothing was filtered; requests, hiding, page protection and the counters now follow the switch.

### Security

- **Extensions kept apart**: a page of one extension can no longer receive the events of another extension (tab addresses and titles, cookies, menu clicks) by naming it.
- **Extension debugger**: a DevTools protocol domain Lucium does not know is refused.

## [0.2.14] - 2026-11-09

### Changed

- **Readable mode button**: each click moves to the next mode, Original, Dark, Light, then Original again; the original has its own icon, a palette; the three icons have their color (dots of paint, a bluish moon, an amber sun), their outline keeping the ink of the bar. Right click still lists every mode.

## [0.2.13] - 2026-11-08

### Added

- **Readable mode, site by site**: Original, Dark (a light page turns dark) or Light (a dark page turns light), with a setting for every other site, including Automatic. In the site control center, View › Appearance, the command bar and Settings › Appearance. Replaces forced dark mode, whose settings are carried over.
- **Recolored, not inverted**: in Dark or Light, each color keeps its hue, text reaches at least a 4.5:1 contrast (3:1 for large text), images and videos keep their colors. A page the recoloring cannot handle is inverted as before.
- **Readable mode button**: in the toolbar, before the site control center, it shows the mode of the page (Original, Dark, Light); a click turns a page dark or light and back to the original, a right click lists every mode. Settings › Appearance › Display can hide it.

## [0.2.12] - 2026-11-08

### Added

- **A look for each Lucium video**: each video comes with a veil on the text side, white text and its shadow, the strength set by how bright the picture is. The Background panel puts the veil (None takes it away) before the text, and Veil Shape is always offered.
- **Two update channels**: stable by default; Settings › General › Receive Test Versions follows the test channel. Moving to an older channel installs nothing.
- **A guide after an import**: after importing from your former sidebar browser, a sheet says once where to find what you knew, with a button to each place; the Help menu opens it again.
- **Report a Problem…** (Help): a plain-text report (version, macOS, extensions, features on, log) to read, copy or save; nothing is sent.
- **A page that stops responding**: Lucium says so, with Reload and Wait; the message goes away as soon as the page responds.
- **Glance and mini window in the history**: their pages join it like a tab's, never for a private tab or a container.
- **Command bar**: Home and End reach the first and last result from the edge of the text.

### Fixed

- **Battery saver**: it pauses the background video, Always Play included, and the button says so.
- **Forced dark mode**: a PDF is no longer inverted, whatever its address.
- **Glance and mini window**: "another site" means the same domain for both.
- **Command bar**: no more site-search row that Tab cannot open.
- **Eraser**: only the selectors it writes itself are kept.
- **Accessibility**: the items of a live folder can be reached with the keyboard, like tabs.
- **Glance › Split View**: with four panes already open, a notice says so. The sweep notice says frozen for a frozen tab.
- **Quotation marks**: texts built in code follow the language: « » in French, “ ” in English.
- **Texts**: custom block lists (a file or pasted rules, never an address), what the plain export keeps, and what the browser trace holds.

### Security

- **Touch ID for the vault**: the key travels through an XPC service of Lucium that checks the caller's signature on every message; a local program posing as Lucium can no longer receive it.
- **Master phrase**: wrong phrases are counted on disk and by every check; relaunching no longer gives three fresh tries. The wait goes from 1 to 30 s and never locks the owner out.
- **Internal messages**: the router itself refuses any sender that is not one of Lucium's surfaces, before any handler runs.
- **Clearing history or a site**: the previous pages kept with archived tabs go too, automatic copies included.
- **Entitlements per piece**: the renderer and GPU helpers check the libraries they load again; only the main process and the helpers protected playback needs keep the exception.
- **Private tabs**: no Tweaks and no user scripts, like a private window (except the scripts you allowed there).
- **Reader mode**: the article's HTML is sanitized before it is shown; the Lucium Status log keeps only file names and sites.

## [0.2.11] - 2026-11-07

### Added

- **Veil shape**: in the Background panel, “Text side” darkens the background under the tabs and fades it towards the right edge, where the video or image shows almost bare. “Even” keeps the veil as before.

### Fixed

- **Text shadow**: wider around the words, it reaches the folders, Today and New Tab. With a chosen text color, sleeping tabs fade less (85%): the list reads over a bright video.

## [0.2.10] - 2026-11-06

### Fixed

- **Lucium videos**: the thumbnails of the Background panel show; they appeared broken.
- **Image background**: an image or a GIF as a space's background shows again, in the sidebar and in the preview of the Background panel.

## [0.2.9] - 2026-11-06

### Added

- **Lucium videos**: nine background videos ship with Lucium, one click away in a space's Background panel: northern lights, temple in the mist, firefly greenhouse, snowy village, forest, mountains, neon city, jellyfish and space porthole. Made for Lucium, they weigh 12 MB in all.
- **Background video**: two small buttons above the sidebar footer when the space has a video behind it: Pause / Play, and “Always play” (∞), which plays the video and keeps it going even when Lucium is not in front. A minimized window still stops it.
- **Tab icon from an image**: “Choose an Image…” in Edit Tab. The image replaces the emoji and the site's icon; a shrunk copy is kept in the profile, like a space's image. “Use the Site’s Icon” takes it away.
- **Command bar**: a “Notifications” button, beside Copy and Paste, opens the recent notifications.

### Fixed

- **Background video**: it no longer stops at each click in a page. Only another window or application in front stops it, unless “Always play” is on.
- **Edit Tab**: the “Save” button is no longer cut off at the right of the bubble.
- **Background video**: the Pause and ∞ buttons sit on a dark pill, readable over a bright video.

## [0.2.8] - 2026-11-06

### Added

- **Sleeping folder**: a folder marked “Never Wake Automatically” carries a small moon at the end of its row, so you can spot it at a glance.

### Fixed

- **Loading at launch**: with “Load All Tabs at Launch”, the pages open in small batches, a few seconds apart, instead of all at once. Dozens of pages made in the same instant came on screen as black rectangles until they were reloaded.
- **Reload All Tabs**: the pages open in the other windows are reloaded too. Until now only the window that was clicked was, and the notice said something like “4 tabs reloaded” while dozens of pages stood still.

## [0.2.7] - 2026-11-06

### Added

- **Recent notifications**: View › Recent Notifications (or “Recent Notifications” in the command bar) lists the last 30 notices of the window, with their time, so a notice that went by too fast can be read again. Nothing is saved: they are gone when the window closes.
- **“Never wake” folders**: the “Never Wake Automatically” tick in a folder's menu keeps its tabs asleep: neither “Reload All Tabs” nor the launch wakes them.

### Changed

- **Sites that no longer answer**: each row has its own “Close” button (“Remove” for a pinned tab) to get rid of one site without ticking; the tab goes to the archive like the others, and the “Undo” notice brings it back.
- **End of a reload**: the notice that says how many tabs were reloaded, which were left as they were and why, stays 15 seconds instead of 5.

### Fixed

- **Extensions**: uBlock Origin Lite starts again. An extension that reads `browser.commands` (or any other `browser.…`) found an empty object, crashed at start, and its worker never ran.

## [0.2.6] - 2026-11-06

### Fixed

- **Video calls**: the video of a call floats in picture-in-picture again when you switch tabs. Lucium measured the video after hiding it and found it too small.

## [0.2.5] - 2026-11-06

### Changed

- **Freeze icon**: the snowflake of a frozen tab is larger and crisper; it keeps its meaning and its place.
- **What's New**: the sheet is wider and its list shows more lines at once, so the text reads without scrolling.

## [0.2.4] - 2026-11-05

### Changed

- **Loading ring of the tabs**: a sharp stroke, a pale track and a turning arc, instead of blurred dots; a tab that “Reload All Tabs” will reload shows the same track, without the arc.

## [0.2.3] - 2026-11-05

This version fixes what a full audit of Lucium found before the beta: windows, sleep, private pages, certificates, local files and profiles.

### Fixed

- **Closing the last window (macOS)**: Lucium stays open like any Mac app, and a click on the Dock, ⌘N, a link from another app or “Check for Updates…” opens the window again with your spaces and tabs, instead of an error at every click.
- **Video calls**: the video of a call floats by itself again when you switch tabs, even though the page mutes it.
- **Sleep without loss**: a tab whose site asks to confirm before leaving stays awake instead of losing what it holds, and text typed in an editor in a frame or boxes ticked in a form not sent keep it awake too.
- **Reload All Tabs**: the tabs of a locked space stay asleep, and a frozen page in which you typed text not sent is no longer reloaded.
- **Interface that does not show**: a screen offers “Reload the Interface” instead of an empty window; your tabs and pages stay intact.
- **Internal errors**: an unexpected error no longer opens alert after alert; it is written to Settings › General › Lucium Status, and a notice says so once.
- **Malformed address**: an unreadable address typed in the bar says “This address is not valid” instead of doing nothing.
- **Archiving and several windows**: automatic archiving and “Clear Today” no longer archive the tab shown in another window; when each window has its own tabs, the tabs of the other windows are archived too once the delay has passed.
- **Profile of a space**: changing it reloads its tabs with the data of the new profile in every window, not only in the one where you changed it.
- **Mini window**: opened from a tab, it takes the profile of that tab's space (its logins), and is archived in that space.
- **Deleting a profile**: “Delete Profile and Its Data” also removes the extensions installed in it and their data, and a profile created again under the same name starts from scratch.
- **Bookmarks file import**: a malformed or hostile HTML bookmarks file no longer freezes Lucium; a megabyte of it took about three seconds, it now takes a few milliseconds.
- **What's New after an update**: the header of the sheet says the update is installed, instead of claiming nothing was downloaded.

### Security

- **Invalid certificates**: `localhost`, a `.local` name or a private address are no longer accepted silently. Only the sites put in Developer Mode (⌃D) go through without asking, and a page opened despite an invalid certificate says “Not secure” instead of the padlock.
- **HTTPS first**: an invalid certificate no longer opens the page over HTTP by itself; the certificate page shows and offers “Open over HTTP (Not Secure)”, on your click only.
- **Local files**: an HTML file opened from your Mac can no longer read other files of the disk; it still shows the images, styles and scripts of its own folder, and local PDFs open as before.
- **Page summary**: a private or guest window never sends its page to a cloud provider or to Ollama on another computer any more, like a private tab; the menu entry is no longer offered there. Ollama on this Mac still summarizes it.
- **HTTP authentication**: a frame of another site inside a page can no longer open the login panel in the tab; only the page itself and its own site can.
- **Icons of private tabs**: a private tab is never looked up by the icon resolver any more, whose answer then went through the disk cache of the interface.
- **Watch This Page**: refused for a private tab, whose address would have been saved and read again with the profile’s cookies.
- **Translation off**: no page reads its language any more, and the page menu no longer offers “Translate This Page…”. On, the language is read in an isolated world the page cannot see.
- **`chrome.debugger`**: an extension can no longer read or rewrite another extension’s scripts on the page, the page’s heap, or the storage of a framed site (the `Debugger`, `DOMDebugger`, `HeapProfiler`, `Memory`, `DOMStorage`, `IndexedDB`, `CacheStorage` and `Database` domains are refused).
- **Sidebar icons**: they no longer carry or receive cookies, since nothing erases the session of the interface; they carry `Sec-GPC` while Global Privacy Control is on.
- **Ollama on another computer**: the connection test and the reading of the models also wait until you confirm its address.
- **Release file**: Lucium reads no more than 64 KB of it; a larger feed is refused without being read to the end.
- **Clear a site's data**: the panel says that clearing cookies also forgets the HTTP authentication credentials of the whole profile, and the README says which User-Agent Lucium's own requests carry.

## [0.2.2] - 2026-11-05

Lucium now tells you by itself that a new version exists; it downloads it only when you ask.

### Added

- **Update notice**: at launch, then once a day, Lucium checks without cookies whether a newer version exists; a notice at the foot of the sidebar offers “Install” or “Later”. Nothing is downloaded before your click, and Settings › General › “Check for updates automatically” turns the check off.
- **New Note button**: in the toolbar, next to “Annotate”, to write a note in one click.
- **Notes in Markdown**: the text takes its look as you type (headings, lists, checkboxes, quotes, bold, italic, code, links) and is still saved as Markdown.
- **Split view in a grid**: four panes in 2 × 2, or three with one along a whole side; dragging a tab onto a split view shows the exact cell it will take, an edge or a corner, and the menu of the view switches between Side by Side, In a Column and Grid.

### Changed

- **Reload All Tabs**: the sidebar buttons reload everything, sleeping tabs included. The button turns during the run, each row shows its turn, and the notice says “12 of 135” with a bar and the time left. Eight sleeping tabs load at once, fewer when memory is short.

### Fixed

- **About window**: the note under “Check for updates” says the button looks right away, whether the automatic check is on or not.
- **Sites that no longer respond**: pinned tabs are listed too, in a group of their own, and go to the archive, from which they come back pinned. The list comes during a long reload, grows while it is open, and Escape no longer hides its tabs for 30 days.

## [0.2.1] - 2026-11-05

Lucium now updates itself, when you ask, and this version fixes what real use brought up.

### Added

- **Updates from the application**: Lucium › Check for Updates… downloads the new version, installs it and restarts Lucium, only when you ask.
- **Unfreeze a tab**: a button on the row of a frozen tab, and an entry in its menu; the page goes on without being reloaded.
- **Sites that no longer respond**: after “Reload All Tabs”, a window lists the tabs whose site cannot be found, to close the ones you check.
- **New Note (⌥⌘E)**: a note tied to the page in one key, also from the command bar.

### Fixed

- **Reload All Tabs** shows its progress from the click, can be stopped, and no longer gets stuck.
- **Split view**: dropping a tab on a view of two or three panes adds one, up to four.
- **Automatic picture in picture**: only for a video you are watching, with sound.
- **Extensions** receive the events of the tabs again.
- **Texts**: the English interface no longer shows French words, the page summary follows the language of the interface, and the settings say what each option really does.

## [0.2.0] - 2026-11-04

The first public version of Lucium: an alpha for macOS on Apple silicon.

### Added

- **A sidebar browser**: a vertical sidebar with spaces (each with its own profile, session and theme), favorites, pinned tabs, nested folders, “Today” tabs with automatic archiving, drag and drop and multiple selection.
- **Command bar (⌘T, ⌘L)**: addresses, search, open and archived tabs, actions, site search shortcuts, inline completion and a calculator.
- **Split View, Glance, mini windows and Tweaks**: two to four panes side by side, a preview of a link, small windows for links opened from other applications, and Tweaks (CSS, JavaScript, elements hidden with the Eraser, colors) that can be shared by file or by link.
- **Extensions (Manifest V3)**: loaded unpacked or installed from the Chrome Web Store, with the side panel, native messaging and extension shortcuts; each API exists only for an extension that declares its permission.
- **Ad and tracker blocker**: on by default, with per-site exceptions, a Standard and a Strict mode, and your own lists.
- **Tab sleep and freeze**: per tab or per site, with the reasons that keep a tab awake (audio, Picture in Picture, a download, unsent input…), a cap of tabs awake in the background and a resource gauge in the sidebar.
- **Privacy without an account**: no account, no synchronization, no telemetry; a private window, private tabs and tab containers, clearing of a site's data (⇧⌘X), HTTPS first, encrypted DNS, a proxy, and the list of every connection Lucium makes by itself in the README.
- **Password manager and lock (off by default)**: an encrypted vault on this Mac, filled on request, with Touch ID, and a lock of the interface or of a space.
- **Import**: from your previous browser, its spaces, tabs, folders, themes, favorites and Tweaks, or its bookmarks and history (Chromium-based and Gecko-based browsers, the browser that comes with macOS), or a bookmarks file.
- **Reading and pages**: reader mode, PDF viewer, per-site zoom, Markdown export, read later, quick notes, and page translation on this Mac (Bergamot models or the translation of macOS 26).
- **Space themes**: a theme editor, twenty ready-made themes, and themes shared as a code.
- **Page summary (off by default)**: from a local Ollama, or from a provider that you allow by name (OpenAI, Mistral, OpenRouter, Anthropic), with your own key.
- **Set up in a few questions**: each category of the Settings can be set by a few questions written in advance, with a summary before anything changes and an Undo; the quick setup asks them all.
- **Settings for every feature**: optional features can be switched off one by one, and the Settings window searches every setting.

### Known limitations

Only macOS on Apple silicon is tested (Windows, Linux and Intel packages are configured but have not been built). The DRM variant, the one releases offer, is signed with Developer ID and notarized by Apple; the standard build (`pnpm package`) is not. There is no automatic update, only a version check against a feed you configure. Extension APIs are partial: Electron implements subsets of them. Protected videos play through Widevine (castLabs' build of Electron, [docs/drm.md](docs/drm.md)); Netflix has been checked, other services have not. Impossible in Electron: Cast, a real background blur behind the command bar, the camera and microphone indicator, haptic feedback.

