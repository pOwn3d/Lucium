import { t } from '@shared/i18n'
import { mountRoot } from './root'
import { AboutWindow } from './AboutWindow'
import { useSnapshot } from './api'
import './styles.css'
import './settings.css'
import { lockDocumentDrops } from './surface'
import { useWindowTitle } from './window-title'

lockDocumentDrops()

/** The window once the snapshot has set the language of the interface (as the Settings window does): before it, every text would be read in French. */
function AboutPage() {
  const snapshot = useSnapshot()
  useWindowTitle(snapshot ? t('menu.a-propos-d-lucium') : null)
  if (!snapshot) return null
  return <AboutWindow />
}

mountRoot(<AboutPage />)
