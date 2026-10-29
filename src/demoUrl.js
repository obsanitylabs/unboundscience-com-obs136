const DEMO_URL = 'https://demo.unboundscience.io'

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
]

// OBS-132 §8: cross-domain jumps (.com -> demo.unboundscience.io) carry UTMs
// explicitly on the CTA. Forward the landing page's captured campaign UTMs
// when present; otherwise tag the placement itself. Internal navigation
// (same-site anchors) never carries UTMs.
export function demoUrl(defaultContent) {
  const url = new URL(DEMO_URL)
  const incoming = new URLSearchParams(window.location.search)
  const forwarded = UTM_KEYS.some((key) => incoming.get(key))
  if (forwarded) {
    UTM_KEYS.forEach((key) => {
      const value = incoming.get(key)
      if (value) url.searchParams.set(key, value)
    })
    return url.toString()
  }
  url.searchParams.set('utm_source', 'other')
  url.searchParams.set('utm_medium', 'referral')
  url.searchParams.set('utm_campaign', 'ubs-landing-cta-2611')
  url.searchParams.set('utm_content', defaultContent)
  return url.toString()
}
