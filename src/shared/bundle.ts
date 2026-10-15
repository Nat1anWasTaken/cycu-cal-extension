// Build-time facts about this package. scripts/build.mjs defines __BUNDLED_MODELS__:
// empty for the online build, [<model>] for an offline one (`--offline=<model>`).

import type { SlmModelId } from './protocol';

declare const __BUNDLED_MODELS__: readonly SlmModelId[];

export const BUNDLED_MODELS: readonly SlmModelId[] = __BUNDLED_MODELS__;

export const isBundled = (id: SlmModelId): boolean => BUNDLED_MODELS.includes(id);
