import { installKioskGuard } from './guard.js';
import { KIOSK_URL } from './config.js';

installKioskGuard(chrome, KIOSK_URL);
