import { App } from './App'
import { mountRoot } from './root'
import './styles.css'
import './private'
import { lockDocumentDrops } from './surface'
import { api } from './api'
import { reportKeyboardLayout } from './keyboard-layout'

lockDocumentDrops()
// The shell recognises a shortcut held with Option (the switcher of tabs on ⌥A) by the layout the window reads.
reportKeyboardLayout((characters) => api().keyboardLayout(characters), (listener) => api().onWindowFocus(listener))

mountRoot(<App />)
