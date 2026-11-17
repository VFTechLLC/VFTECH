// Shared by tests/emails.test.mjs: the renderer and the list of compiled emails.
export {render} from '../backend/mailer.js';
import {EMAILS} from '../backend/emails.generated.js';
export const EMAIL_NAMES = Object.keys(EMAILS);
