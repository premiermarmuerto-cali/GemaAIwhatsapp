/**
 * Versión visible del panel (login y consola). Sale de package.json: al publicar una actualización
 * se sube ahí ("1.4.0" → "1.5.0") y se anota en CHANGELOG.md. Se muestra sin el último número.
 */
import pkg from '../package.json'

export const APP_VERSION = pkg.version.split('.').slice(0, 2).join('.')
