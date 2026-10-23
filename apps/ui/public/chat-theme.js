// Runs before first paint, so a saved theme never flashes the other one.
try { var t = localStorage.getItem('augur.chat.theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) { /* blocked storage: follow the system */ }
