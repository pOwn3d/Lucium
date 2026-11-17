import { ExtensionsPage } from './ExtensionsPage'
import { mountRoot } from './root'
import './styles.css'
import './settings.css'
import './templates/primitives.css'
import './extensions-page.css'
import { lockDocumentDrops } from './surface'

lockDocumentDrops()

mountRoot(<ExtensionsPage />)
