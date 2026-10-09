'use strict'
// Loaded blocking in <head> so the saved theme applies before first paint.
;(function () {
  const THEMES = ['system', 'light', 'dark']
  const LABELS = { system: '◐ Sistema', light: '☀ Clar', dark: '☾ Fosc' }
  let theme = 'system'
  try { theme = localStorage.getItem('theme') || 'system' } catch { /* storage blocked */ }
  if (!THEMES.includes(theme)) theme = 'system'

  function apply() {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
    const button = document.getElementById('theme')
    if (button) {
      button.textContent = LABELS[theme]
      button.title = 'Canvia el tema (sistema, clar, fosc)'
    }
  }

  apply()
  document.addEventListener('DOMContentLoaded', () => {
    apply()
    document.getElementById('theme').addEventListener('click', () => {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]
      try { localStorage.setItem('theme', theme) } catch { /* storage blocked */ }
      apply()
    })
  })
})()
