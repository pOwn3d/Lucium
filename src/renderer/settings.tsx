import { SettingsWindow } from './SettingsWindow'
import { mountRoot } from './root'
import './styles.css'
import './settings.css'
import { lockDocumentDrops } from './surface'

lockDocumentDrops()

mountRoot(<SettingsWindow />)
