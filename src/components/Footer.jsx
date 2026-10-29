import { demoUrl } from '../demoUrl'
import styles from './Footer.module.css'

const LOGO_SRC = `${import.meta.env.BASE_URL || '/'}logo.png`

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.content}>
        <div className={styles.brand}>
          <img className={styles.logo} src={LOGO_SRC} alt="Unbound Science" />
        </div>
        <div className={styles.links}>
          <a href="#problem">Mission</a>
          <a href="#how">Team</a>
          <a href={demoUrl('lnk-footer-demo-01')}>Demo</a>
          <a href="https://twitter.com/unboundscience" target="_blank" rel="noopener noreferrer">
            Twitter
          </a>
        </div>
        <div className={styles.copyright}>© 2026 Unbound Science</div>
      </div>
    </footer>
  )
}
