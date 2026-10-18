// @ts-check
/** Product identity and distribution policy, shared by the reused CLI and local service.
 * product.json is intentionally never replaced by the upstream packaging hooks.
 */
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';

export const PRODUCT = /** @type {{ id: string, displayName: string, directorName: string, command: string, packageName: string, homepage: string, sourceUrl: string, releasesUrl: string, upstreamUrl: string, examplesUrl: string, dataDirectory: string, libraryDirectory: string, healthProduct: string, managedUpdates: boolean, desktopPromotion: boolean, desktop: { updates: string } }} */ (JSON.parse(readFileSync(new URL('../product.json', import.meta.url), 'utf8')));

/** Text shown when an upstream updater is requested. This build has no npm self-update channel. */
export const MANAGED_UPDATE_MESSAGE = `${PRODUCT.displayName} is managed by DesireCore. Update the installed application through DesireCore; for a source checkout, update this repository and rebuild it. The upstream OpenFilm npm package is never installed by this command.`;

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../product.schema.json', import.meta.url), 'utf8')));
if (!validate(PRODUCT)) throw new Error(`Invalid 视频创作 product.json: ${ajv.errorsText(validate.errors)}`);
