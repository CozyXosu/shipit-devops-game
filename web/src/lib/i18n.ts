// Localization (P4): interface chrome in English, Spanish and German.
// The terminal stays POSIX — game narrative ships in English; the chrome is
// what every user stares at, so that is what localizes first.

export type Locale = 'en' | 'es' | 'de';

export const LOCALES: { id: Locale; label: string; flag: string }[] = [
  { id: 'en', label: 'English', flag: '🇬🇧' },
  { id: 'es', label: 'Español', flag: '🇪🇸' },
  { id: 'de', label: 'Deutsch', flag: '🇩🇪' }
];

export function isLocale(v: string): v is Locale {
  return v === 'en' || v === 'es' || v === 'de';
}

type Dict = Record<string, string>;

const EN: Dict = {
  'tab.missions': 'MISSIONS', 'tab.terminal': 'TERMINAL', 'tab.editor': 'EDITOR', 'tab.dashboard': 'DASHBOARD',
  'tab.ci': 'CI / CD', 'tab.k8s': 'KUBERNETES', 'tab.database': 'DATABASE', 'tab.monitoring': 'MONITORING',
  'tab.cloud': 'CLOUD', 'tab.company': 'COMPANY', 'tab.costs': 'COSTS', 'tab.incidents': 'INCIDENTS', 'tab.portal': 'PORTAL', 'tab.modes': 'MODES',
  'top.day': 'Day', 'top.cash': 'Cash', 'top.users': 'Users', 'top.uptime': 'Uptime', 'top.infra': 'Infra', 'top.exit': 'exit',
  'top.pause': 'pause', 'top.speed': 'speed',
  'landing.sub': 'A DevOps company simulator. One broken server. One demo at 10:30. Build the platform, run the company.',
  'landing.continue': 'Continue', 'landing.new': 'New company', 'landing.founder': 'Founder (you report to)',
  'landing.mode.tutorial': 'Tutorial', 'landing.mode.career': 'Career', 'landing.mode.sandbox': 'Sandbox',
  'landing.mode.tutorial.sub': 'Same 20 build missions + operate phase, gentler pacing.',
  'landing.mode.career.sub': 'Start from zero. Grow into production. Recommended.',
  'landing.mode.sandbox.sub': '$250k budget, free building, no missions pressure.',
  'landing.found': 'FOUND THE COMPANY →',
  'modes.headline': 'Modes & content at scale',
  'modes.sub': 'Mission packs, the postmortem tournament, challenges, and access & language settings.',
  'modes.packs': 'Mission packs', 'modes.packs.format': 'Format',
  'modes.packs.activate': 'ACTIVATE', 'modes.packs.active': 'ACTIVE', 'modes.packs.missions': 'missions',
  'modes.tournament': 'Postmortem tournament', 'modes.tournament.you': 'YOU', 'modes.tournament.rivals': 'Rivals',
  'modes.tournament.points': 'points', 'modes.tournament.rounds': 'rounds won', 'modes.tournament.place': 'Final place',
  'modes.tournament.none': 'No tournament running — activate the tournament pack above.',
  'modes.challenges': 'Challenges', 'modes.challenges.start': 'ACCEPT', 'modes.challenges.abandon': 'ABANDON',
  'modes.challenges.passed': 'passed', 'modes.challenges.failed': 'failed', 'modes.challenges.score': 'score',
  'modes.challenges.record': 'Record', 'modes.challenges.days': 'Daily verdicts', 'modes.challenges.minutesLeft': 'minutes left',
  'modes.challenges.bill': 'Bill now', 'modes.challenges.cap': 'Cap', 'modes.challenges.windowed': 'Windowed availability',
  'modes.challenges.badmin': 'bad minutes', 'modes.challenges.none': 'No challenge running. Pick your constraint.',
  'modes.access': 'Access & language', 'modes.access.language': 'Interface language',
  'modes.access.highContrast': 'High contrast', 'modes.access.largeText': 'Large text', 'modes.access.reducedMotion': 'Reduced motion',
  'modes.access.on': 'ON', 'modes.access.off': 'OFF',
  'modes.access.note': 'Keyboard: Alt+1…9 switches tabs, Alt+0 opens MODES. Terminal and audit feed announce updates to screen readers.',
  'modes.gated': 'Unlocks after mission 28 — or anywhere in sandbox.',
  'dock.hint': 'Hint', 'dock.pack': 'PACK MISSION', 'dock.noHints': 'No more hints — you are on your own, engineer.',
  'dock.solve': '⚡ Solve it for me', 'dock.solving': '⚡ Solving…',
  'solve.done': 'AUTO-SOLVED', 'solve.incomplete': 'AUTO-SOLVE INCOMPLETE', 'solve.steps': 'steps', 'solve.whatItDid': 'what it did'
};

const ES: Dict = {
  'tab.missions': 'MISIONES', 'tab.terminal': 'TERMINAL', 'tab.editor': 'EDITOR', 'tab.dashboard': 'PANEL',
  'tab.ci': 'CI / CD', 'tab.k8s': 'KUBERNETES', 'tab.database': 'BASE DE DATOS', 'tab.monitoring': 'MONITOREO',
  'tab.cloud': 'NUBE', 'tab.company': 'EMPRESA', 'tab.costs': 'COSTOS', 'tab.incidents': 'INCIDENTES', 'tab.portal': 'PORTAL', 'tab.modes': 'MODOS',
  'top.day': 'Día', 'top.cash': 'Caja', 'top.users': 'Usuarios', 'top.uptime': 'Disponibilidad', 'top.infra': 'Infra', 'top.exit': 'salir',
  'top.pause': 'pausa', 'top.speed': 'velocidad',
  'landing.sub': 'Un simulador de empresa DevOps. Un servidor roto. Una demo a las 10:30. Construye la plataforma, dirige la empresa.',
  'landing.continue': 'Continuar', 'landing.new': 'Nueva empresa', 'landing.founder': 'Fundador (tu jefe)',
  'landing.mode.tutorial': 'Tutorial', 'landing.mode.career': 'Carrera', 'landing.mode.sandbox': 'Sandbox',
  'landing.mode.tutorial.sub': 'Las mismas 20 misiones de construcción + fase de operación, ritmo más suave.',
  'landing.mode.career.sub': 'Empieza de cero. Crece hasta producción. Recomendado.',
  'landing.mode.sandbox.sub': '$250k de presupuesto, construcción libre, sin presión de misiones.',
  'landing.found': 'FUNDAR LA EMPRESA →',
  'modes.headline': 'Modos y contenido a escala',
  'modes.sub': 'Packs de misiones, el torneo de postmortems, desafíos y accesibilidad e idioma.',
  'modes.packs': 'Packs de misiones', 'modes.packs.format': 'Formato',
  'modes.packs.activate': 'ACTIVAR', 'modes.packs.active': 'ACTIVO', 'modes.packs.missions': 'misiones',
  'modes.tournament': 'Torneo de postmortems', 'modes.tournament.you': 'TÚ', 'modes.tournament.rivals': 'Rivales',
  'modes.tournament.points': 'puntos', 'modes.tournament.rounds': 'rondas ganadas', 'modes.tournament.place': 'Puesto final',
  'modes.tournament.none': 'Sin torneo en curso — activa el pack del torneo arriba.',
  'modes.challenges': 'Desafíos', 'modes.challenges.start': 'ACEPTAR', 'modes.challenges.abandon': 'ABANDONAR',
  'modes.challenges.passed': 'superado', 'modes.challenges.failed': 'fallido', 'modes.challenges.score': 'puntuación',
  'modes.challenges.record': 'Historial', 'modes.challenges.days': 'Veredictos diarios', 'modes.challenges.minutesLeft': 'minutos restantes',
  'modes.challenges.bill': 'Factura actual', 'modes.challenges.cap': 'Límite', 'modes.challenges.windowed': 'Disponibilidad medida',
  'modes.challenges.badmin': 'minutos malos', 'modes.challenges.none': 'Sin desafío en curso. Elige tu restricción.',
  'modes.access': 'Accesibilidad e idioma', 'modes.access.language': 'Idioma de la interfaz',
  'modes.access.highContrast': 'Alto contraste', 'modes.access.largeText': 'Texto grande', 'modes.access.reducedMotion': 'Menos movimiento',
  'modes.access.on': 'SÍ', 'modes.access.off': 'NO',
  'modes.access.note': 'Teclado: Alt+1…9 cambia de pestaña, Alt+0 abre MODOS. El terminal y el feed anuncian cambios a lectores de pantalla.',
  'modes.gated': 'Se desbloquea tras la misión 28 — o siempre en sandbox.',
  'dock.hint': 'Pista', 'dock.pack': 'MISIÓN DE PACK', 'dock.noHints': 'No quedan pistas — estás solo, ingeniero/a.',
  'dock.solve': '⚡ Resuélvela por mí', 'dock.solving': '⚡ Resolviendo…',
  'solve.done': 'AUTO-RESUELTA', 'solve.incomplete': 'AUTO-RESOLUCIÓN INCOMPLETA', 'solve.steps': 'pasos', 'solve.whatItDid': 'lo que hizo'
};

const DE: Dict = {
  'tab.missions': 'MISSIONEN', 'tab.terminal': 'TERMINAL', 'tab.editor': 'EDITOR', 'tab.dashboard': 'ÜBERSICHT',
  'tab.ci': 'CI / CD', 'tab.k8s': 'KUBERNETES', 'tab.database': 'DATENBANK', 'tab.monitoring': 'MONITORING',
  'tab.cloud': 'CLOUD', 'tab.company': 'FIRMA', 'tab.costs': 'KOSTEN', 'tab.incidents': 'VORFÄLLE', 'tab.portal': 'PORTAL', 'tab.modes': 'MODI',
  'top.day': 'Tag', 'top.cash': 'Kasse', 'top.users': 'Nutzer', 'top.uptime': 'Verfügbarkeit', 'top.infra': 'Infra', 'top.exit': 'beenden',
  'top.pause': 'pause', 'top.speed': 'tempo',
  'landing.sub': 'Ein DevOps-Firmensimulator. Ein kaputter Server. Eine Demo um 10:30. Baue die Plattform, führe die Firma.',
  'landing.continue': 'Fortsetzen', 'landing.new': 'Neue Firma', 'landing.founder': 'Gründer (dein Chef)',
  'landing.mode.tutorial': 'Tutorial', 'landing.mode.career': 'Karriere', 'landing.mode.sandbox': 'Sandbox',
  'landing.mode.tutorial.sub': 'Dieselben 20 Build-Missionen + Operate-Phase, ruhigeres Tempo.',
  'landing.mode.career.sub': 'Bei null anfangen. Bis Produktion wachsen. Empfohlen.',
  'landing.mode.sandbox.sub': '$250k Budget, freies Bauen, kein Missionsdruck.',
  'landing.found': 'FIRMA GRÜNDEN →',
  'modes.headline': 'Modi & Inhalt im großen Stil',
  'modes.sub': 'Missionspakete, das Postmortem-Turnier, Challenges sowie Barrierefreiheit & Sprache.',
  'modes.packs': 'Missionspakete', 'modes.packs.format': 'Format',
  'modes.packs.activate': 'AKTIVIEREN', 'modes.packs.active': 'AKTIV', 'modes.packs.missions': 'Missionen',
  'modes.tournament': 'Postmortem-Turnier', 'modes.tournament.you': 'DU', 'modes.tournament.rivals': 'Rivalen',
  'modes.tournament.points': 'Punkte', 'modes.tournament.rounds': 'gewonnene Runden', 'modes.tournament.place': 'Endplatz',
  'modes.tournament.none': 'Kein Turnier aktiv — oben das Turnier-Paket aktivieren.',
  'modes.challenges': 'Challenges', 'modes.challenges.start': 'ANNEHMEN', 'modes.challenges.abandon': 'ABBRECHEN',
  'modes.challenges.passed': 'bestanden', 'modes.challenges.failed': 'gescheitert', 'modes.challenges.score': 'Punkte',
  'modes.challenges.record': 'Bilanz', 'modes.challenges.days': 'Tagesurteile', 'modes.challenges.minutesLeft': 'Minuten übrig',
  'modes.challenges.bill': 'Rechnung', 'modes.challenges.cap': 'Limit', 'modes.challenges.windowed': 'Gemessene Verfügbarkeit',
  'modes.challenges.badmin': 'schlechte Minuten', 'modes.challenges.none': 'Keine Challenge aktiv. Wähle deine Einschränkung.',
  'modes.access': 'Zugang & Sprache', 'modes.access.language': 'Sprache der Oberfläche',
  'modes.access.highContrast': 'Hoher Kontrast', 'modes.access.largeText': 'Große Schrift', 'modes.access.reducedMotion': 'Weniger Bewegung',
  'modes.access.on': 'AN', 'modes.access.off': 'AUS',
  'modes.access.note': 'Tastatur: Alt+1…9 wechselt Tabs, Alt+0 öffnet MODI. Terminal und Audit-Feed melden Updates an Screenreader.',
  'modes.gated': 'Schaltet nach Mission 28 frei — oder jederzeit im Sandbox.',
  'dock.hint': 'Tipp', 'dock.pack': 'PAKET-MISSION', 'dock.noHints': 'Keine Tipps mehr — du bist auf dich gestellt.',
  'dock.solve': '⚡ Löse sie für mich', 'dock.solving': '⚡ Löse…',
  'solve.done': 'AUTO-GELÖST', 'solve.incomplete': 'AUTO-LÖSUNG UNVOLLSTÄNDIG', 'solve.steps': 'Schritte', 'solve.whatItDid': 'was getan wurde'
};

const DICT: Record<Locale, Dict> = { en: EN, es: ES, de: DE };

export type T = (key: string) => string;

export function makeT(locale: Locale): T {
  const d = DICT[locale] ?? EN;
  return (key: string) => d[key] ?? EN[key] ?? key;
}
