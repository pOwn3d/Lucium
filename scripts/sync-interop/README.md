# Mac ↔ iPhone interoperability check

Proves that the **real code of the Mac** (TypeScript, `src/main/sync/`, run under Node with no Electron and no window) and the **real code of the iPhone** (the
application's `SyncController` and `LuciumKit`, Swift, in an iOS simulator) understand each other over a **real TLS connection on a real address of this machine's
local network**. Nothing is relaxed on either side: the Mac's door keeps its local-address filter (docs/synchronisation.md §6.2), the phone's connector refuses the
loopback. The result and its figures are in [docs/synchronisation.md](../../docs/synchronisation.md) §30 (in French).

## Run it

```sh
scripts/sync-interop/run.sh                       # every check, about three minutes
scripts/sync-interop/run.sh --only testPairingThenSessionsInBothDirections
LUCIUM_INTEROP_SOAK_SECONDS=600 scripts/sync-interop/run.sh --report /tmp/interop   # the ten-minute soak, about fourteen minutes
```

It opens **no window**: the Mac is a Node process, the simulator is booted in the background by `simctl` (never `Simulator.app`) and deleted at the end, like
`scripts/ios-check.sh`. It is heavy (a Swift build, a simulator): say so before running it on a machine somebody is using (AGENTS.md §1). Nothing is signed for a
device and nothing leaves the machine's local network. Needs `xcodegen` (as `ios-check.sh`), Node 26 and the dependencies of the repository.

| Variable | Meaning |
|---|---|
| `LUCIUM_INTEROP_SOAK_SECONDS` | length of the 30-second loop (default 90) |
| `LUCIUM_INTEROP_TABS` | Today tabs per device in the measures and the soak (default 200) |
| `LUCIUM_INTEROP_INTERFACE` | the network interface the Mac listens on (default: the first private IPv4 of an `en*`); the check stops if the machine has none |
| `LUCIUM_IOS_RUNTIME`, `LUCIUM_IOS_DEVICE` | the simulator, as in `ios-check.sh` |

`pnpm test:sync-interop-peer` starts the Mac alone (it prints its control port and waits), to look at it by hand with `curl`. `pnpm test` runs `mac-peer.test.ts`
(the Mac's address choice and its control server, without a phone); the check itself is **not** part of `pnpm test`, and `ios-check.sh` skips it (no control port).

## How it is made

- `mac-peer.ts`: the Mac. The real `SyncService` (listener, pairing, session, merge, `sync/apply` of the reducer) over a state it holds itself. Stand-ins, and only
  these: the sealing of the identity key (a reversible XOR instead of `safeStorage`, which needs Electron) and the state holder (a plain object instead of the window's
  store). Everything is written in a throw-away folder. A control server on the loopback (`POST /pair`, `/dispatch`, `/seed-today`, `/lock-space`, `/reset`…, `GET /state`,
  `/status`, `/base`, `/metrics`) lets the phone side drive it; `mac-peer.run.ts` starts it (through `vitest.sync-interop.config.mts`).
- `ios/LuciumTests/SyncInteropSupport.swift`, `SyncInteropTests.swift`: the phone. A real `BrowserModel` and `SyncController` over the real `NetworkSyncConnector` (bytes counted),
  a Mac client, and the checks. Skipped unless `LUCIUM_INTEROP_PORT` is set (which `run.sh` does).
- `run.sh`: starts the Mac, boots the simulator, runs the tests, stops and deletes everything.

## What it proves

| Test | What it shows |
|---|---|
| `testPairingThenSessionsInBothDirections` | the pairing of §4.7 (the two devices show the same words; a second phone with the used QR gets nothing); a full session; Today tabs both ways (too young to be shared, then shared with their page, closed, pinned and detached, read there and closed here, locked space); structure deleted both ways (space, folder, favourite, pinned tab); both bases equal after a session |
| `testPairingRefusedOnThePhoneKeepsNothing` | a pairing the phone declines leaves nothing on either side |
| `testACategoryTickedAloneOrWithoutStructureTakesNothingAwayFromEitherSide` | `todayTabs` and `archive` ticked alone or on one side only never empty the other side |
| `testMeasuresWith200TodayTabsOnEachDevice` | size of the messages, time to apply, the cap of 200 (§27.4); writes `measures.json` |
| `testADeviceThatReceived200TabsStillSharesItsOwnFirstOne` | an expected failure that documents a finding: the cap counts the tabs received |
| `testASessionEvery30SecondsForTheLengthOfTheSoak` | the application's interval loop at 30 seconds on the real Mac: sessions, bytes, CPU and memory of both processes; writes `soak.json` |

## What it does not prove

A real iPhone, a real Wi-Fi between two machines (here the phone's connection goes to this machine's own address: it is the same TCP/TLS stack, but over the loopback
interface of the host), the `.local` name, the local-network permission prompt, the camera, `safeStorage`, Electron's own Node. The CPU and memory of the phone are those of the
test process in the simulator (the web views are other processes); the Mac's are those of the Node process.
