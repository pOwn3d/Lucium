// What Electron sees of the machine that runs the engine checks: the screen and the animation settings of the system. The Smoke (macOS) workflow prints it
// before and after it puts the animations back on, so that a log says on what screen and with which settings the suites ran. It opens no window.
// Run with `electron scripts/runner-facts.cjs`.
const { app, screen, systemPreferences } = require('electron')

void app
  .whenReady()
  .then(() => {
    const display = screen.getPrimaryDisplay()
    const { x, y, width, height } = display.bounds
    console.log(`runner-facts: screen ${width} x ${height} at (${x}, ${y}), work area ${display.workArea.width} x ${display.workArea.height}, scale ${display.scaleFactor}, ${screen.getAllDisplays().length} display(s)`)
    console.log(`runner-facts: animations ${JSON.stringify(systemPreferences.getAnimationSettings())}`)
    app.quit()
  })
  .catch((error) => {
    // The step that runs this fails with the reason, rather than going on with no facts.
    console.error('runner-facts: the machine cannot be read:', error)
    app.exit(1)
  })
