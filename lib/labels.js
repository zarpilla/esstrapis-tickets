// Catalan labels for statuses, types and priorities (emails and translated logs).
const LABELS = {
  todo: 'Pendent', 'in-progress': 'En procés', blocked: 'Bloquejat', review: 'En revisió', done: 'Fet', wontfix: 'Descartat',
  bug: 'Error', improvement: 'Millora', suggestion: 'Suggeriment',
  low: 'baixa', medium: 'mitjana', high: 'alta', urgent: 'urgent',
}
const label = (k) => LABELS[k] || k

module.exports = { label }
