import { useState, useEffect } from 'react'
import { demoUrl } from '../demoUrl'
import styles from './Navbar.module.css'

const LOGO_SRC = `${import.meta.env.BASE_URL || '/'}logo.png`

export function Navbar() {
  const [isScrolled, setIsScrolled] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const closeMobileMenu = () => setIsMobileMenuOpen(false)

  return (
    <>
      <nav className={`${styles.navbar} ${isScrolled ? styles.scrolled : ''}`}>
        <a href="#" className={styles.logo}>
          <img src={LOGO_SRC} alt="Unbound Science" />
        </a>

        <div className={styles.links}>
          <a href="#problem">Mission</a>
          <a href="#how">How it Works</a>
          <a href="#focus">Areas</a>
          <a href="#stats">Community</a>
          <a href={demoUrl('btn-launch-01')} className={styles.cta}>
            Launch App
          </a>
        </div>

        <button
          className={styles.mobileToggle}
          onClick={() => setIsMobileMenuOpen(true)}
          aria-label="Open menu"
        >
          <span></span>
          <span></span>
          <span></span>
        </button>
      </nav>

      {/* Mobile Menu */}
      <div className={`${styles.mobileMenu} ${isMobileMenuOpen ? styles.active : ''}`}>
        <button
          className={styles.mobileClose}
          onClick={closeMobileMenu}
          aria-label="Close menu"
        >
          &times;
        </button>
        <a href="#problem" onClick={closeMobileMenu}>Mission</a>
        <a href="#how" onClick={closeMobileMenu}>How it Works</a>
        <a href="#focus" onClick={closeMobileMenu}>Areas</a>
        <a href="#stats" onClick={closeMobileMenu}>Community</a>
        <a href={demoUrl('btn-launch-02')} onClick={closeMobileMenu} className={styles.cta}>
          Launch App
        </a>
      </div>
    </>
  )
}
