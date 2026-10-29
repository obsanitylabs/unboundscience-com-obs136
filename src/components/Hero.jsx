import { useRef, useCallback } from 'react'
import { useScrollVideo } from '../hooks/useScrollVideo'
import { demoUrl } from '../demoUrl'
import styles from './Hero.module.css'

export function Hero() {
  const heroRef = useRef(null)
  const { contentOpacity, initCanvas } = useScrollVideo(heroRef)

  const canvasRef = useCallback((node) => {
    if (node) {
      initCanvas(node)
    }
  }, [initCanvas])

  return (
    <section className={styles.hero} id="hero" ref={heroRef}>
      <div className={styles.sticky}>
        <div className={styles.canvasWrapper}>
          <canvas ref={canvasRef} className={styles.canvas}></canvas>
        </div>
        <div className={styles.overlay}></div>
        <div className={styles.content} style={{ opacity: contentOpacity }}>
          <h1 className={styles.title}>Science shouldn't need permission</h1>
          <p className={styles.subtitle}>
            A platform where inventors can seek support, document their work, and share breakthrough technology — in public.
          </p>
          <div className={styles.buttons}>
            <a href={demoUrl('btn-hero-scientist-01')} className={styles.btnSecondary}>
              I'm a Scientist
            </a>
            <a href={demoUrl('btn-hero-donor-01')} className={styles.btnPrimary}>
              I'm a Donor
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
